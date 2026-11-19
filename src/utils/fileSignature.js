/**
 * Server-side content check for stored uploads. The name and mimetype of an
 * upload are both supplied by the client, so before any bytes are stored we
 * confirm that formats with a well-known signature really start with it: a
 * `.pdf` must be a PDF, a `.docx` a ZIP container, a `.jpg` some real bitmap.
 *
 * Image extensions accept ANY known bitmap signature, because phone pickers do
 * misname files (a HEIC saved as `.jpg`) and that is harmless; what this stops
 * is markup or a script dressed up as a document or picture. Formats without a
 * reliable signature (txt, csv, rtf, dcm) are left to the mimetype allowlist.
 */
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../config/constants");
const { IMAGE_EXTENSIONS, extensionOf } = require("../config/storage");

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** Which family the leading bytes belong to, or null when unrecognised. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return "image";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image";
  if (startsWith(buf, ascii("GIF8"))) return "image";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "image";
  if (startsWith(buf, ascii("BM"))) return "image";
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return "image"; // TIFF
  if (startsWith(buf, ascii("ftyp"), 4)) return "image"; // HEIC / HEIF / AVIF (ISO-BMFF)
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return "zip"; // docx / xlsx / odt / ods
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole"; // doc / xls
  // The PDF spec lets the header sit anywhere in the first 1 KB.
  if (buf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "pdf";
  return null;
}

/** Extension → the family its bytes must belong to. */
const EXPECTED = Object.freeze({
  pdf: "pdf",
  docx: "zip",
  xlsx: "zip",
  odt: "zip",
  ods: "zip",
  doc: "ole",
  xls: "ole",
});

/** Throws a 422 when the bytes are not the format the file name claims. */
function assertContentMatchesName(buffer, filename) {
  const ext = extensionOf(filename);
  const want = IMAGE_EXTENSIONS.has(ext) ? "image" : EXPECTED[ext];
  if (!want) return;
  if (sniff(buffer) !== want) {
    throw new ApiError(422, `This file is not a valid .${ext} file — it may be damaged or renamed`, {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
}

module.exports = { sniff, assertContentMatchesName };
