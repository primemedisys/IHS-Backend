/**
 * Builds and exports the Express app (middleware + routes + error handling).
 * It does NOT listen or touch the DB — that's server.js's job. Keeping app
 * construction pure makes it importable in tests without opening a port.
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");

const env = require("./config/env");
const routes = require("./routes");
const swaggerSpec = require("./config/swagger");
const { globalLimiter } = require("./middlewares/rateLimiters");
const { notFound, errorHandler } = require("./middlewares/errorHandler");
const fileUrlReplacer = require("./utils/fileUrlReplacer");
const { INLINE_EXTENSIONS: INLINE_UPLOAD_EXT, isPublicKey } = require("./config/storage");

const app = express();

// Every JSON response: private stored files become short-lived signed
// /api/files links, public Cloudinary images get optimised delivery.
app.set("json replacer", fileUrlReplacer);

/**
 * How many proxy hops sit in front of this process. `req.ip` is read that many
 * entries back from X-Forwarded-For, and EVERY per-IP rate limiter keys on it.
 *
 * Get this wrong and the failure is silent but severe: too high and a client
 * can spoof its way into a fresh bucket; too LOW and every user resolves to the
 * proxy's address, so the whole platform shares one bucket and everybody starts
 * 429ing at once. Configurable because the answer differs per deployment —
 * nginx alone is 1, Cloudflare→nginx is 2, an ALB behind Cloudflare is 3.
 */
app.set("trust proxy", env.TRUST_PROXY_HOPS);
app.use(helmet());
const clientOrigins = env.CLIENT_URL.split(",").map((u) => u.trim());
app.use(cors({ origin: clientOrigins, credentials: true }));
// Capture the raw request body alongside JSON parsing so webhooks can verify
// their signature over the exact bytes the provider signed (Razorpay's HMAC in
// paymentWebhook.controller; LiveKit's signed JWT in videoWebhook.controller).
// `verify` runs before the parsed body is built. LiveKit posts with a
// `application/webhook+json` content type, so match it too or its raw body
// (and signature check) would be missed.
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "application/webhook+json"],
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// A private file link is a bearer credential until it expires — keep it out of access logs.
morgan.token("url", (req) =>
  String(req.originalUrl || req.url).replace(/\/files\/[^/?#]+/g, "/files/[redacted]")
);
app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

// Serve locally-stored uploads when STORAGE_DRIVER is `local` — and, after a
// switch to Cloudinary/S3, whenever the folder still exists, so files stored
// before the switch keep loading (CLOUDINARY_SETUP.md §"Existing files").
// The frontends embed these files cross-origin (<img> avatars, the in-app PDF
// report viewer's <iframe>), and they run on a different origin in dev — so
// helmet's same-origin embed defaults must be relaxed for THIS route only.
//
// Only PUBLIC files (config/storage) are served here. Private ones — records,
// reports, prescriptions, certificates — reach clients solely through signed,
// expiring /api/files links, so a copied /uploads URL is not a way in.
/** The normalised storage key a /uploads request asks for, or null if unsafe. */
function requestedUploadKey(reqPath) {
  try {
    const decoded = decodeURIComponent(reqPath);
    if (decoded.includes("\\") || decoded.includes("\0")) return null;
    return path.posix.normalize(decoded).replace(/^\/+/, "");
  } catch {
    return null;
  }
}
if (env.STORAGE_DRIVER === "local" || fs.existsSync(path.resolve(env.UPLOAD_DIR))) {
  app.use(
    "/uploads",
    (req, res, next) => (isPublicKey(requestedUploadKey(req.path)) ? next() : res.status(404).end()),
    express.static(env.UPLOAD_DIR, {
      /**
       * An uploaded record is immutable once written — a correction is a NEW
       * row with a new file, never an edit in place. So a long cache is safe,
       * and it is what makes the record reader's scroll instant: without it,
       * every scan the browser has evicted is re-fetched on the way back up,
       * and an X-ray is measured in megabytes.
       */
      maxAge: "7d",
      immutable: true,
      setHeaders: (res, filePath) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.removeHeader("X-Frame-Options");
        res.removeHeader("Content-Security-Policy");
        // Only passive formats render in the browser. Anything else (an .html
        // or .svg that slipped in under an image mimetype, a .docx, …) is a
        // download, so a stored file can never run script on the API origin.
        if (!INLINE_UPLOAD_EXT.has(path.extname(filePath).slice(1).toLowerCase())) {
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", "attachment");
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    })
  );
}

// Interactive API docs (Swagger UI) + raw spec. Mounted before the rate limiter
// so browsing docs never counts against the API quota.
// Off by default in production (API_DOCS_ENABLED) — the full route map and
// schemas are reconnaissance material for an attacker.
if (env.API_DOCS_ENABLED) {
  app.get(`${env.API_PREFIX}/docs.json`, (_req, res) => res.json(swaggerSpec));
  app.use(`${env.API_PREFIX}/docs`, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

app.use(env.API_PREFIX, globalLimiter, routes); // e.g. /api/auth/...

app.use(notFound); // unmatched route → 404 ApiError
app.use(errorHandler); // must be the LAST middleware

module.exports = app;
