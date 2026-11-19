/**
 * GET /api/files/:token/:name — stream a private stored file behind a
 * backend-signed, expiring link (services/fileAccess.service).
 *
 * No `authenticate`: the frontends open these in <img>, <iframe>, a new tab and
 * the Expo in-app browser, none of which can send a bearer token. The signed
 * token IS the authorisation, and it is only ever minted inside a response the
 * route guards already authorised.
 */
const asyncHandler = require("../utils/asyncHandler");
const fileAccessService = require("../services/fileAccess.service");

/** Never let a private file sit in a shared cache, and never past its link. */
const MAX_PRIVATE_CACHE_SECONDS = 600;

exports.open = asyncHandler(async (req, res) => {
  const file = await fileAccessService.openLink(req.params.token);
  const remaining = Math.max(0, file.expiresAt - Math.floor(Date.now() / 1000));

  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", file.buffer.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", `private, max-age=${Math.min(MAX_PRIVATE_CACHE_SECONDS, remaining)}`);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // The portals embed these cross-origin (<img>, the PDF <iframe>) — relax
  // helmet's same-origin embed defaults for THIS response only, as /uploads does.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Frame-Options");
  res.removeHeader("Content-Security-Policy");
  // Only passive formats render in the browser; Word, Excel, DICOM, RTF … download.
  if (!file.inline) {
    const name = encodeURIComponent(file.fileName);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${name}`);
  }
  return res.send(file.buffer);
});
