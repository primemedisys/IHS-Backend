/**
 * Storage policy — which stored files are PUBLIC and how each format is handled.
 * Shared by every storage driver, the /uploads static route and the private
 * file-link service, so the rules live in exactly one place (CLOUDINARY_SETUP.md).
 *
 * A storage key is `<keyPrefix>/<uuid>-<safe name>` (see upload.service). The
 * prefix says what the file is, so it also decides who may see it.
 */

/**
 * The ONLY prefixes that are public: pictures that are rendered for anyone
 * browsing the platform (avatars, a doctor's public profile, the medicine
 * catalogue, a UPI QR a patient must scan to pay). Everything else — patient
 * records, lab reports, prescriptions, prescription requests, verification
 * certificates, blood-request documents, letterhead + signature assets — is
 * PRIVATE. Unknown prefixes are private too: a new upload category is never
 * public by accident.
 */
const PUBLIC_KEY_PATTERNS = Object.freeze([
  /^doctor\/[0-9]+\/(photo|gallery|showcase|hero|award|testimonial)\/[^/]+$/,
  /^patient\/[0-9]+\/photo\/[^/]+$/,
  /^payment-qr\/[0-9]+\/[^/]+$/,
  /^medicine\/masters\/[0-9]+\/images\/[^/]+$/,
]);

/** A key may only contain these characters and never a `.`/`..` segment. */
const SAFE_KEY = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;
const isSafeKey = (key) =>
  typeof key === "string" && SAFE_KEY.test(key) && !key.split("/").some((s) => s === "." || s === "..");

const isPublicKey = (key) => isSafeKey(key) && PUBLIC_KEY_PATTERNS.some((re) => re.test(key));
const isPrivateKey = (key) => !isPublicKey(key);

/** Bitmap formats Cloudinary stores as `image` (validated + transformable). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"]);

/** Formats safe to render inline in a browser (passive images, PDF, plain text). */
const INLINE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf", "txt", "csv"]);

/** Extension for an upload whose name has none, from its declared type. */
const EXTENSION_FOR_MIME = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/plain": "txt",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "application/dicom": "dcm",
});

const extensionOf = (name) => {
  const base = String(name || "").split("?")[0].split("#")[0].split("/").pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

module.exports = {
  PUBLIC_KEY_PATTERNS,
  IMAGE_EXTENSIONS,
  INLINE_EXTENSIONS,
  EXTENSION_FOR_MIME,
  isSafeKey,
  isPublicKey,
  isPrivateKey,
  extensionOf,
};
