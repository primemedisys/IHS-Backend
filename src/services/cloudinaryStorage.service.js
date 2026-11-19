/**
 * Cloudinary storage driver (STORAGE_DRIVER=cloudinary — CLOUDINARY_SETUP.md).
 * Used only through upload.service, which keeps the `{ url, key }` contract
 * every caller already relies on.
 *
 * One storage key maps to exactly one asset, deterministically:
 *
 *   key           doctor/7/docs/<uuid>-degree.pdf
 *   resource_type `image` for bitmaps (Cloudinary validates them), `raw` for
 *                 everything else — PDF, Word, Excel, DICOM, text. Documents are
 *                 never treated as images, so no account-level PDF setting or
 *                 image transformation ever touches them.
 *   type          `upload` (public CDN) only for config/storage PUBLIC prefixes;
 *                 `authenticated` for everything else — those assets cannot be
 *                 fetched from Cloudinary without a signature made by this server.
 *   public_id     <CLOUDINARY_FOLDER>/<key>   (image public ids drop the extension)
 *
 * The persisted reference stays a URL, as for every other driver:
 *   https://res.cloudinary.com/<cloud>/<resource_type>/<type>/v<version>/<public_id>[.<format>]
 * For a private asset that URL is inert — it returns 401 without a signature.
 */
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const { isConfigured, getCloudinary } = require("../config/cloudinary");
const { IMAGE_EXTENSIONS, isPrivateKey, isSafeKey, extensionOf } = require("../config/storage");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

const PUBLIC = "upload";
const PRIVATE = "authenticated";
/** Signed server-side read links only need to outlive one fetch. */
const READ_LINK_SECONDS = 120;
/** Deletions that failed are queued here (JSON lines) for `--cleanup` to retry. */
const CLEANUP_QUEUE_FILE = path.resolve("storage-cleanup.jsonl");

const stripExt = (key) => key.replace(/\.[^./]+$/, "");

/** Everything Cloudinary needs to address the asset behind a storage key. */
function assetForKey(key) {
  const ext = extensionOf(key);
  const resourceType = IMAGE_EXTENSIONS.has(ext) ? "image" : "raw";
  return {
    key,
    resourceType,
    deliveryType: isPrivateKey(key) ? PRIVATE : PUBLIC,
    publicId: `${env.CLOUDINARY_FOLDER}/${resourceType === "image" ? stripExt(key) : key}`,
    format: resourceType === "image" ? ext : undefined,
  };
}

/** The canonical, untransformed, unsigned delivery URL we persist. */
function canonicalUrl({ resourceType, deliveryType, version, publicId, format }) {
  const file = resourceType === "image" && format ? `${publicId}.${format}` : publicId;
  return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/${deliveryType}/v${version}/${file}`;
}

const URL_RE = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw)\/(upload|authenticated)\/((?:[^/]+\/)*?)v(\d+)\/([^?#]+)$/;

/**
 * Parse a stored URL back into its asset — or null when it is not one of OURS
 * (another cloud, another root folder, an unsafe path). Tolerates a delivery
 * transformation segment, so a public image URL a client echoes back still parses.
 */
function parseUrl(url) {
  if (typeof url !== "string" || !env.CLOUDINARY_CLOUD_NAME) return null;
  const m = URL_RE.exec(url.split("#")[0].split("?")[0]);
  if (!m || m[1] !== env.CLOUDINARY_CLOUD_NAME) return null;
  let file;
  try {
    file = decodeURIComponent(m[6]);
  } catch {
    return null;
  }
  const root = `${env.CLOUDINARY_FOLDER}/`;
  if (!file.startsWith(root)) return null;
  const key = file.slice(root.length);
  if (!isSafeKey(key)) return null;
  const [, , resourceType, deliveryType, transformation, version] = m;
  const format = resourceType === "image" ? extensionOf(key) : undefined;
  return {
    key,
    resourceType,
    deliveryType,
    version,
    transformation: transformation.replace(/\/$/, "") || null,
    publicId: `${env.CLOUDINARY_FOLDER}/${resourceType === "image" ? stripExt(key) : key}`,
    format,
  };
}

/** Map an SDK failure to an ApiError the client can act on — never a raw 500. */
function storageError(err) {
  const httpCode = err?.http_code || err?.error?.http_code;
  const message = String(err?.message || err?.error?.message || "unknown error");
  // Never log the payload or a URL; the provider message carries neither secret nor content.
  console.error(`❌ Cloudinary request failed (${httpCode || "network"}): ${message}`);
  if (httpCode === 400 && /size/i.test(message)) {
    return new ApiError(422, "The file is larger than the storage plan allows", { code: ERROR_CODES.VALIDATION_ERROR });
  }
  if (httpCode === 400) {
    return new ApiError(422, "The file could not be stored — it may be damaged or not the type its name says", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  return new ApiError(502, "File storage is temporarily unavailable — please try again", {
    code: ERROR_CODES.STORAGE_UNAVAILABLE,
  });
}

/** Upload `buffer` under `key`. Resolves to `{ url, key }` only once verified. */
async function put(buffer, key) {
  const cloudinary = getCloudinary();
  const asset = assetForKey(key);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: asset.publicId,
          resource_type: asset.resourceType,
          type: asset.deliveryType,
          overwrite: false,
          unique_filename: false,
          use_filename: false,
          timeout: env.CLOUDINARY_TIMEOUT_MS,
        },
        (err, res) => (err ? reject(err) : resolve(res))
      );
      stream.end(buffer);
    });
  } catch (err) {
    throw storageError(err);
  }

  // Trust the stored asset only if it is the one we asked for, byte for byte.
  const sameAsset =
    result?.public_id === asset.publicId && (result.type == null || result.type === asset.deliveryType);
  const sameSize = result?.bytes == null || Number(result.bytes) === buffer.length;
  if (!sameAsset || !sameSize || !result.version) {
    if (result?.public_id) await remove(key).catch(() => {});
    throw new ApiError(502, "File storage returned an unexpected result — please try again", {
      code: ERROR_CODES.STORAGE_UNAVAILABLE,
    });
  }

  const format = asset.resourceType === "image" ? String(result.format || asset.format).toLowerCase() : undefined;
  const storedKey = asset.resourceType === "image" ? `${stripExt(key)}.${format}` : key;
  return {
    key: storedKey,
    url: canonicalUrl({ ...asset, version: result.version, format }),
  };
}

/** Fetch with the configured timeout; null on any non-2xx. */
async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(env.CLOUDINARY_TIMEOUT_MS) });
  if (!res.ok) return { status: res.status, buffer: null };
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
}

/**
 * Read the bytes of a parsed asset server-side. Private assets are read through
 * a signed link that expires in two minutes and never leaves this process.
 */
async function read(asset) {
  if (!isConfigured()) return null;
  const cloudinary = getCloudinary();
  if (asset.deliveryType === PUBLIC) {
    return (await fetchBytes(canonicalUrl(asset))).buffer;
  }
  // 1) The download API: signed, expiring, independent of CDN delivery settings.
  const downloadUrl = cloudinary.utils.private_download_url(asset.publicId, asset.format || "", {
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    expires_at: Math.floor(Date.now() / 1000) + READ_LINK_SECONDS,
  });
  const first = await fetchBytes(downloadUrl);
  if (first.buffer) return first.buffer;
  // 2) Fallback: a signed CDN delivery URL (also server-side only).
  const signed = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    version: asset.version,
    format: asset.format,
    sign_url: true,
    secure: true,
  });
  const second = await fetchBytes(signed);
  if (!second.buffer) console.warn(`⚠️  Cloudinary read failed (${first.status}/${second.status}) for an IHS asset`);
  return second.buffer;
}

/** Record a deletion that could not be completed, so it can be retried. */
function queueCleanup(key, reason) {
  try {
    fs.appendFileSync(CLEANUP_QUEUE_FILE, `${JSON.stringify({ key, reason, at: new Date().toISOString() })}\n`);
  } catch {
    /* the warning below is the fallback record */
  }
  console.warn(`⚠️  Cloudinary asset left for cleanup (${reason}): ${key}`);
}

/**
 * Delete the asset behind a storage key. NEVER throws — a failed delete must
 * not fail the user's request after their row is already gone; the key is
 * queued for `node scripts/migrateUploadsToCloudinary.js --cleanup` instead.
 * Resolves true when Cloudinary confirmed the asset is gone.
 */
async function remove(key) {
  if (!key || !isSafeKey(key) || !isConfigured()) return false;
  const asset = assetForKey(key);
  try {
    const cloudinary = getCloudinary();
    const opts = { resource_type: asset.resourceType, invalidate: true };
    let res = await cloudinary.uploader.destroy(asset.publicId, { ...opts, type: asset.deliveryType });
    // Classification is by prefix; if it ever changes, the asset sits under the other type.
    if (res?.result === "not found") {
      res = await cloudinary.uploader.destroy(asset.publicId, {
        ...opts,
        type: asset.deliveryType === PUBLIC ? PRIVATE : PUBLIC,
      });
    }
    return res?.result === "ok" || res?.result === "not found";
  } catch (err) {
    queueCleanup(key, String(err?.message || err?.error?.message || "delete failed").slice(0, 200));
    return false;
  }
}

/** Public image URL with the configured delivery optimisation (f_auto/q_auto/size cap). */
function optimisedPublicUrl(url, asset) {
  if (asset.resourceType !== "image" || asset.deliveryType !== PUBLIC || asset.transformation) return url;
  if (!env.CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION) return url;
  return url.replace(
    `/image/upload/v${asset.version}/`,
    `/image/upload/${env.CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION}/v${asset.version}/`
  );
}

/** Non-fatal boot check: are the credentials accepted? Logs, never throws. */
async function ping() {
  if (!isConfigured()) return false;
  try {
    await getCloudinary().api.ping();
    return true;
  } catch (err) {
    console.error(`❌ Cloudinary credentials were rejected or unreachable: ${err?.error?.message || err?.message || err}`);
    return false;
  }
}

module.exports = {
  put,
  read,
  remove,
  parseUrl,
  assetForKey,
  canonicalUrl,
  optimisedPublicUrl,
  ping,
  isConfigured,
  CLEANUP_QUEUE_FILE,
  PUBLIC,
  PRIVATE,
};
