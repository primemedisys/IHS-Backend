/**
 * Express `json replacer` (app.js): every JSON response passes through here,
 * so a stored file reference can never leave the API in a form the client
 * should not hold — whichever serializer or controller emitted it.
 *
 *  - private file → a short-lived backend-signed /api/files link
 *  - public Cloudinary image → the optimised CDN URL
 *  - anything else → unchanged
 *
 * One choke point instead of a call in each of the ~20 serializers that emit
 * `fileUrl`, `pdfUrl`, `documentUrl`, `signatureUrl`, … — a new serializer is
 * covered automatically. Fail-closed: a private Cloudinary URL that somehow
 * skipped this would still be useless to the client (it needs a signature).
 */
const { deliveryUrl, mightBeStoredFile } = require("../services/fileAccess.service");

module.exports = function fileUrlReplacer(_key, value) {
  return typeof value === "string" && mightBeStoredFile(value) ? deliveryUrl(value) : value;
};
