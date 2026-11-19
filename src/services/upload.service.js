/**
 * Storage abstraction (README §6, CLOUDINARY_SETUP.md). One interface, three
 * drivers selected by env.STORAGE_DRIVER for NEW uploads:
 *   - `local` writes bytes to disk under UPLOAD_DIR and serves them via
 *     `GET /uploads/...` (zero cloud setup for dev).
 *   - `s3` uploads to an S3 bucket and returns the object URL.
 *   - `cloudinary` uploads to Cloudinary (public CDN for public images,
 *     `authenticated` delivery for everything sensitive).
 *
 * Callers (document/photo controllers) only ever see `{ url, key }` — they never
 * know which driver ran, so switching provider is a pure env change.
 *
 * Reads and deletes follow the REFERENCE, not the active driver: a URL stored
 * under `local` before the switch to Cloudinary still reads from disk. Nothing
 * stored earlier stops working when the driver changes.
 *
 *   put(buffer, { keyPrefix, filename, mimetype }) -> { url, key }
 *   storeThen(buffer, opts, commit)  — put, and discard the file if commit throws
 *   remove(key)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const env = require("./../config/env");
const cloud = require("./cloudinaryStorage.service");
const { EXTENSION_FOR_MIME, extensionOf } = require("../config/storage");
const { assertContentMatchesName } = require("../utils/fileSignature");

/** Make a user-supplied filename safe to sit in a URL / on disk. */
function safeName(filename, mimetype) {
  const base = path.basename(filename || "file");
  let name = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
  // An extension-less upload gets one from its (allowlisted) type, so the
  // stored file is served with the right Content-Type and viewer.
  if (!extensionOf(name) && EXTENSION_FOR_MIME[mimetype]) name = `${name}.${EXTENSION_FOR_MIME[mimetype]}`;
  return name;
}

/** `<keyPrefix>/<uuid>-<safe filename>` — the storage key, driver-agnostic. */
function buildKey(keyPrefix, filename, mimetype) {
  const clean = String(keyPrefix || "misc").replace(/^\/+|\/+$/g, "");
  return `${clean}/${crypto.randomUUID()}-${safeName(filename, mimetype)}`;
}

/**
 * Absolute on-disk path for a storage key — or null when the key would land
 * outside UPLOAD_DIR (`../`, an absolute path, …). Every local read, write and
 * delete goes through this, so a URL a user typed in can never reach a file
 * the API didn't store itself.
 */
function localPathFor(key) {
  if (!key) return null;
  const root = path.resolve(env.UPLOAD_DIR);
  const dest = path.resolve(root, String(key));
  return dest.startsWith(root + path.sep) ? dest : null;
}

/** Our own S3 object host (only meaningful when STORAGE_DRIVER=s3). */
const s3Host = () => (env.S3_BUCKET && env.S3_REGION ? `${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com` : null);

// ── local driver ────────────────────────────────────────────────────────────
const local = {
  async put(buffer, key) {
    const dest = localPathFor(key);
    if (!dest) throw new Error("Invalid storage key");
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, buffer);
    // Absolute URL so the frontend renders it directly (same code as S3).
    return { key, url: `${env.PUBLIC_URL.replace(/\/+$/, "")}/uploads/${key}` };
  },
  async remove(key) {
    const dest = localPathFor(key);
    if (!dest) return;
    await fs.promises.rm(dest, { force: true });
  },
};

// ── s3 driver (lazy-loaded so @aws-sdk isn't required for local dev) ──────────
function s3Driver() {
  // eslint-disable-next-line global-require
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({ region: env.S3_REGION });
  return {
    async put(buffer, key, { mimetype }) {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
        })
      );
      return { key, url: `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}` };
    },
    async remove(key) {
      if (!key) return;
      await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    },
  };
}
let _s3;
const s3 = () => (_s3 ||= s3Driver());

/**
 * Store a file with the active driver. The bytes are checked against the
 * format the name claims BEFORE anything is written (utils/fileSignature).
 */
async function put(buffer, { keyPrefix, filename, mimetype }) {
  assertContentMatchesName(buffer, safeName(filename, mimetype));
  const key = buildKey(keyPrefix, filename, mimetype);
  if (env.STORAGE_DRIVER === "cloudinary") return cloud.put(buffer, key);
  if (env.STORAGE_DRIVER === "s3") return s3().put(buffer, key, { mimetype });
  return local.put(buffer, key);
}

/**
 * Delete the stored object(s) for a key. Under Cloudinary this also removes a
 * pre-migration local copy of the same key, since the caller is deleting the
 * file itself. Cloudinary failures never throw — they are queued for cleanup.
 */
async function remove(key) {
  if (!key) return;
  if (env.STORAGE_DRIVER === "s3") {
    await s3().remove(key);
    return;
  }
  await local.remove(key);
  if (cloud.isConfigured()) await cloud.remove(key);
}

/** Remove a just-stored file that no row will ever reference. Never throws. */
async function discard(key) {
  try {
    await remove(key);
  } catch (err) {
    console.warn(`⚠️  Could not discard an orphaned upload (${err.message}): ${key}`);
  }
}

/**
 * Store a file, then run `commit(stored)` (the DB write that references it).
 * If the commit throws, the new file is discarded and the error re-thrown —
 * so a failed DB write never leaves an orphan, and the PREVIOUS reference
 * (which the commit never replaced) keeps working.
 */
async function storeThen(buffer, opts, commit) {
  const stored = await put(buffer, opts);
  try {
    return await commit(stored);
  } catch (err) {
    await discard(stored.key);
    throw err;
  }
}

/**
 * The local driver stores the storage KEY inside the returned URL
 * (`.../uploads/<key>`), but we persist the URL, not the key. This recovers the
 * key from a stored URL so `remove()` can delete the underlying object.
 */
function keyFromUrl(url) {
  if (!url) return null;
  const asset = cloud.parseUrl(url);
  if (asset) return asset.key;
  const marker = "/uploads/";
  const idx = url.indexOf(marker);
  if (idx !== -1) return url.slice(idx + marker.length);
  // S3 object URL: everything after the host is the key — but only for OUR
  // bucket. A pasted link to any other host is not ours to read or delete.
  try {
    const u = new URL(url);
    const host = s3Host();
    if (env.STORAGE_DRIVER !== "s3" || !host || u.host !== host) return null;
    return decodeURIComponent(u.pathname.replace(/^\/+/, "")) || null;
  } catch {
    return null;
  }
}

/**
 * Read a stored object's bytes back, given the URL we persisted. Cloudinary
 * assets are read with a short-lived server-side signature; local files come
 * off disk (whatever the active driver); S3 objects are fetched. Used to stream
 * a private file through the API so access is re-checked on every download,
 * rather than handing out the storage URL.
 */
async function readByUrl(url) {
  if (!url) return null;
  const asset = cloud.parseUrl(url);
  if (asset) return cloud.read(asset);
  if (url.includes("/uploads/")) {
    const dest = localPathFor(keyFromUrl(url));
    if (!dest || !fs.existsSync(dest)) return null;
    return fs.promises.readFile(dest);
  }
  // Only ever fetch objects in our own bucket — never an arbitrary stored URL
  // (that would let a pasted link make the server fetch internal addresses).
  if (!keyFromUrl(url)) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Content-Type for streaming a stored file back through the API, from its
 * name's extension. Unknown types fall back to a download-only octet-stream.
 */
const CONTENT_TYPES = Object.freeze({
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  dcm: "application/dicom",
});
function contentTypeFor(fileName) {
  const ext = String(fileName || "").split("?")[0].split(".").pop()?.toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

module.exports = { put, storeThen, remove, discard, keyFromUrl, readByUrl, contentTypeFor, localPathFor };
