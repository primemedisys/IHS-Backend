/**
 * Stream a stored file (read through upload.service) inline to the client,
 * never cached. Used by every route that serves a private document through
 * the API instead of exposing its storage URL (diagnostic prescriptions and
 * reports, blood-request supporting documents).
 *
 * `download: true` sends it as an attachment (generated spreadsheets such as
 * the pharmacy import template / inventory export) instead of inline.
 *
 * @param {import('express').Response} res
 * @param {{buffer: Buffer, contentType: string, fileName: string}} file
 * @param {{download?: boolean}} [options]
 */
module.exports = function sendFile(res, file, { download = false } = {}) {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(file.fileName)}"`
  );
  res.setHeader("Content-Length", file.buffer.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(file.buffer);
};
