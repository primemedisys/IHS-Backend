/**
 * Multipart upload middleware (backend-plan.md §6). `multer` parses the file
 * into memory (`req.file.buffer`); the upload.service — not this middleware —
 * decides where the bytes land. A `fileFilter` + `limits.fileSize` enforce the
 * allowed types/size as the AUTHORITY (the frontend dropzone mirrors them for UX).
 *
 * multer's own errors (e.g. file too large) are translated to a 422 ApiError so
 * they render through the standard error envelope instead of a raw 500.
 */
const multer = require("multer");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

/**
 * What may be uploaded as a report or document.
 *
 * Widened twice. First from PDF/PNG/JPEG only, because a lab report arrives as
 * whatever the lab's app produced — a phone photo (HEIC on any recent iPhone),
 * a scan (TIFF), a screenshot (WebP). Then again for the formats hospitals and
 * labs actually hand people: an Excel or CSV panel of results, and DICOM, which
 * is what every X-ray and MRI machine emits.
 *
 * `image/*` is matched by PREFIX rather than enumerated, so a format we have
 * not heard of still works.
 *
 * It is deliberately NOT "allow anything". These files are served back to
 * doctors and patients IN-BROWSER from the API's own origin, so an uploaded
 * .html — or an .svg, which is an image that may contain <script> — becomes
 * stored XSS against every user who opens it. Executables and archives are
 * refused for the same reason: nothing here should be a delivery mechanism.
 */
const ALLOWED_MIME = [
  "application/pdf",
  // Office / text documents people get from a lab or hospital.
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/plain",
  // Spreadsheets — how most labs send a panel of numbers.
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  // Medical imaging, straight off the machine.
  "application/dicom",
];

/**
 * Image types that are NOT safe to serve inline.
 *
 * SVG is markup, not a bitmap: it can carry <script> and executes when opened
 * in a tab. It would otherwise sail through the `image/` prefix check below.
 */
const BLOCKED_IMAGE_MIME = ["image/svg+xml"];

/**
 * File EXTENSIONS that browsers execute or render as active content. The
 * declared mimetype comes from the client, so a page saved as `evil.html` but
 * sent as `image/png` would pass the mimetype check — the stored name keeps
 * its extension, and the static server picks the Content-Type from it.
 */
const BLOCKED_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "js", "mjs", "cjs", "php", "exe", "bat", "cmd", "sh", "msi", "jar"]);
const extensionOf = (name) => String(name || "").toLowerCase().split(".").pop();

/** Any image type except the unsafe ones, plus the explicit document list. */
const isAllowedMime = (mimetype) =>
  typeof mimetype === "string" &&
  !BLOCKED_IMAGE_MIME.includes(mimetype) &&
  (mimetype.startsWith("image/") || ALLOWED_MIME.includes(mimetype));

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMime(file.mimetype) && !BLOCKED_EXTENSIONS.has(extensionOf(file.originalname))) return cb(null, true);
    return cb(
      new ApiError(422, "Unsupported file type — upload an image, PDF, document, spreadsheet or scan", {
        code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      })
    );
  },
});

/**
 * Wrap `multerUpload.single(field)` so a MulterError (size/limit) becomes a
 * clean 422 ApiError, and a missing file becomes a clear 422 too.
 */
function single(field, { required = true } = {}) {
  const handler = multerUpload.single(field);
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? `File is too large (max ${env.MAX_UPLOAD_MB} MB)`
            : `Upload error: ${err.message}`;
        return next(new ApiError(422, message, { code: ERROR_CODES.VALIDATION_ERROR }));
      }
      if (err) return next(err); // e.g. the ApiError from fileFilter
      if (required && !req.file) {
        return next(
          new ApiError(422, "A file is required", { code: ERROR_CODES.VALIDATION_ERROR })
        );
      }
      return next();
    });
}

module.exports = { single, ALLOWED_MIME, isAllowedMime };
