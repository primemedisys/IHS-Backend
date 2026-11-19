/**
 * Delivery of stored files to clients (CLOUDINARY_SETUP.md §"Private files").
 *
 * PUBLIC images (avatars, gallery, medicine pictures, UPI QR) are delivered
 * straight from their storage URL — the Cloudinary CDN, optimised.
 *
 * PRIVATE files (records, reports, prescriptions, certificates …) are never
 * handed out as a storage URL. Wherever one would appear in an API response it
 * is replaced (utils/fileUrlReplacer) by a link to THIS server:
 *
 *   <PUBLIC_URL><API_PREFIX>/files/<token>/<file name.ext>
 *
 * `token` is an HMAC (keyed off JWT_ACCESS_SECRET, made server-side only) over
 * the stored reference and an expiry. It is minted only inside a response the
 * existing route guards already authorised — the patient's own records, a
 * doctor's consented/booked view, an admin review — so it carries exactly the
 * access that response granted, and stops working after FILE_URL_TTL_MINUTES.
 * Guessing an asset id or a Cloudinary URL gets nothing: a private Cloudinary
 * asset needs this server's signature, and a token needs this server's key.
 *
 * Links are stable within a TTL window (expiry is rounded up), so the same
 * file in two responses gets the same URL and the browser cache still works.
 */
const crypto = require("crypto");
const env = require("../config/env");
const upload = require("./upload.service");
const cloud = require("./cloudinaryStorage.service");
const { isPrivateKey, isSafeKey, INLINE_EXTENSIONS, extensionOf } = require("../config/storage");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

const LINK_KEY = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("ihs:file-link:v1").digest();
const TTL_SECONDS = env.FILE_URL_TTL_MINUTES * 60;
const FILES_BASE = `${env.PUBLIC_URL.replace(/\/+$/, "")}${env.API_PREFIX}/files`;

const mac = (payload) => crypto.createHmac("sha256", LINK_KEY).update(payload).digest("base64url");

/** Expiry for a link minted now: between one and two TTLs away, on a stable boundary. */
const expiryFor = (nowSeconds) => (Math.floor(nowSeconds / TTL_SECONDS) + 2) * TTL_SECONDS;

function signRef(ref, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ r: ref, e: expiryFor(nowSeconds) })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** Verify a link token → the stored reference. 404 when forged, 403 when expired. */
function verifyToken(token) {
  const [payload, sig, extra] = String(token || "").split(".");
  if (!payload || !sig || extra !== undefined) throw ApiError.notFound("File not found");
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw ApiError.notFound("File not found");
  }
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw ApiError.notFound("File not found");
  }
  if (typeof body?.r !== "string" || !Number.isFinite(body?.e)) throw ApiError.notFound("File not found");
  if (body.e * 1000 <= Date.now()) {
    throw ApiError.forbidden("This file link has expired — reload the page to get a new one", {
      code: ERROR_CODES.FILE_LINK_EXPIRED,
    });
  }
  return { ref: body.r, expiresAt: body.e };
}

/** `<uuid>-` — the prefix upload.service puts on every file name it stores. */
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/**
 * The storage key of a reference the LOCAL driver wrote, else null. Matched on
 * the key's shape (`/uploads/<prefix>/<uuid>-<name>`), not on PUBLIC_URL, so
 * rows stored while the API ran on another origin/port are still recognised —
 * while a pasted link to some other site's /uploads/ folder is left alone.
 */
function ownLocalKey(value) {
  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/uploads/")) return null;
  let key;
  try {
    key = decodeURIComponent(pathname.slice("/uploads/".length));
  } catch {
    return null;
  }
  return isSafeKey(key) && STORED_NAME.test(key.split("/").pop()) ? key : null;
}

/** Human file name for a key: drop the `<uuid>-` storage prefix. */
const displayName = (key) => String(key).split("/").pop().replace(STORED_NAME, "") || "file";

const privateLink = (ref, key) => `${FILES_BASE}/${signRef(ref)}/${encodeURIComponent(displayName(key))}`;

/**
 * The URL a client should receive for a stored reference. Anything that is
 * not one of our stored files (a pasted link, plain text) comes back untouched.
 */
function deliveryUrl(value) {
  if (typeof value !== "string") return value;
  const asset = cloud.parseUrl(value);
  if (asset) {
    if (asset.deliveryType === cloud.PRIVATE) return privateLink(value, asset.key);
    return cloud.optimisedPublicUrl(value, asset);
  }
  const key = ownLocalKey(value);
  if (key && isPrivateKey(key)) return privateLink(value, key);
  return value;
}

/** Cheap pre-filter for the JSON replacer: could this string be a stored file? */
const mightBeStoredFile = (value) =>
  value.length > 24 &&
  value.charCodeAt(0) === 104 && // "h" of http(s)
  (value.includes("res.cloudinary.com/") || value.includes("/uploads/"));

/**
 * Resolve a link token to the file's bytes and serving metadata. The token is
 * the authorisation (see header); the bytes come through upload.readByUrl, so
 * a local reference stays contained to UPLOAD_DIR and a Cloudinary one is read
 * with a two-minute server-side signature.
 */
async function openLink(token) {
  const { ref, expiresAt } = verifyToken(token);
  const key = upload.keyFromUrl(ref);
  const buffer = key ? await upload.readByUrl(ref) : null;
  if (!buffer) throw ApiError.notFound("File not found");
  const fileName = displayName(key);
  return {
    buffer,
    fileName,
    contentType: upload.contentTypeFor(fileName),
    inline: INLINE_EXTENSIONS.has(extensionOf(fileName)),
    expiresAt,
  };
}

module.exports = { deliveryUrl, mightBeStoredFile, openLink, signRef, verifyToken, displayName };
