/**
 * Loads and validates process.env ONCE at startup with Joi, then exports a
 * frozen, typed config object. If anything is missing or malformed the process
 * exits immediately with a readable report — we never boot in a half-configured
 * state, and no other module ever touches `process.env` directly.
 */
require("dotenv").config();

const Joi = require("joi");

const schema = Joi.object({
  // ── Server ───────────────────────────────────────────────
  NODE_ENV: Joi.string().valid("development", "test", "production").default("development"),
  PORT: Joi.number().default(5000),
  API_PREFIX: Joi.string().default("/api"),
  // Comma-separated list — one origin per frontend app (patient/doctor/admin).
  CLIENT_URL: Joi.string()
    .required()
    .custom((value, helpers) => {
      const urls = value.split(",").map((u) => u.trim()).filter(Boolean);
      if (!urls.length) return helpers.error("any.invalid");
      for (const u of urls) {
        try {
          new URL(u);
        } catch {
          return helpers.error("any.invalid");
        }
      }
      return value;
    }, "comma-separated list of URLs"),

  // ── Database (MySQL) ─────────────────────────────────────
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(3306),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow("").required(),

  // ── JWT ──────────────────────────────────────────────────
  // In production the placeholders from .env.example are refused, so a copied
  // example file can never boot a live server with a publicly known secret.
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .required()
    .when("NODE_ENV", { is: "production", then: Joi.invalid("replace-with-a-64-char-random-string-at-least-32-long") }),
  JWT_ACCESS_TTL: Joi.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: Joi.number().default(30),

  // ── Admin seed ───────────────────────────────────────────
  ADMIN_NAME: Joi.string().default("Platform Admin"),
  ADMIN_EMAIL: Joi.string().email().required(),
  ADMIN_PASSWORD: Joi.string()
    .min(8)
    .required()
    .when("NODE_ENV", { is: "production", then: Joi.invalid("Str0ng!AdminPass") }),

  // ── Google OAuth ─────────────────────────────────────────
  GOOGLE_CLIENT_ID: Joi.string().allow("").default(""),

  // ── Nodemailer (SMTP) ────────────────────────────────────
  SMTP_HOST: Joi.string().allow("").default(""),
  SMTP_PORT: Joi.number().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow("").default(""),
  SMTP_PASSWORD: Joi.string().allow("").default(""),
  MAIL_FROM: Joi.string().default("Indian Health System <no-reply@localhost>"),

  // ── Password reset ───────────────────────────────────────
  RESET_TOKEN_TTL_MINUTES: Joi.number().default(45),
  // Forgot-password by mobile OTP (migration 050).
  PASSWORD_OTP_TTL_MINUTES: Joi.number().integer().min(1).max(30).default(10),
  PASSWORD_OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  // Codes sent to ONE number per rolling hour, and the minimum gap between two.
  PASSWORD_OTP_MAX_PER_HOUR: Joi.number().integer().min(1).max(20).default(5),
  PASSWORD_OTP_RESEND_SECONDS: Joi.number().integer().min(0).max(600).default(60),

  // ── Transactional SMS (services/sms.service.js) ──────────
  // "none" (default) = not configured: the OTP endpoint answers 503 rather than
  // pretending a code was sent. "mock" prints the SMS to the server console and
  // is refused in production. "twilio" uses TWILIO_ACCOUNT_SID/AUTH_TOKEN below.
  SMS_PROVIDER: Joi.string().valid("twilio", "mock", "none").default("none"),
  // Optional: the doctor website's origin (e.g. http://localhost:3001). When
  // set, a DOCTOR's email reset link opens the doctor site's reset page; when
  // blank every link uses the first CLIENT_URL, exactly as before.
  DOCTOR_APP_URL: Joi.string().uri().allow("").default(""),
  TWILIO_SMS_FROM: Joi.string().allow("").default(""),

  // ── Razorpay (online payments) ───────────────────────────
  // Required (non-empty) in production; blank in dev keeps the offline flow
  // working while online payments stay disabled until test keys are added.
  // Only RAZORPAY_KEY_ID is ever sent to the client (public key).
  RAZORPAY_KEY_ID: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  RAZORPAY_KEY_SECRET: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),

  // ── LiveKit (video consultation — docs/video-consultation) ─
  // Required (non-empty) in production; blank in dev keeps every other feature
  // working while video calls stay disabled until Cloud keys are added. Only
  // LIVEKIT_URL is ever sent to the client (public wss:// SFU URL) — the API
  // key/secret stay server-side and only ever sign tokens/verify webhooks.
  LIVEKIT_URL: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().uri({ scheme: ["ws", "wss"] }).required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  LIVEKIT_API_KEY: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  LIVEKIT_API_SECRET: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),

  // ── Prescription PDF rendering (docs/prescriptions) ──────
  // `puppeteer` drives headless Chromium; `none` disables rendering entirely
  // (CI/test) so the rest of the API can be exercised without a browser.
  PDF_ENGINE: Joi.string().valid("puppeteer", "none").default("puppeteer"),
  PDF_TIMEOUT_MS: Joi.number().default(15000),
  PDF_MAX_CONCURRENCY: Joi.number().min(1).default(2),
  // Point at a system Chromium in slim images; blank = puppeteer's bundled one.
  PUPPETEER_EXECUTABLE_PATH: Joi.string().allow("").default(""),
  // Fallback prescription-number prefix when a template sets none.
  RX_NUMBER_PREFIX: Joi.string().default("RX"),
  // Renders per minute per doctor (preview + finalize each spawn a Chromium page).
  PDF_RATE_LIMIT_MAX: Joi.number().default(20),
  // Doctor → other-patient search (per doctor, per minute) and record-access
  // requests (per doctor, per hour) — consent-workflow abuse guards.
  PATIENT_SEARCH_RATE_LIMIT_MAX: Joi.number().default(20),
  ACCESS_REQUEST_RATE_LIMIT_MAX: Joi.number().default(20),
  // Account creation / Google sign-in and password-reset emails, per IP per
  // RATE_LIMIT_WINDOW_MIN. These count EVERY request (unlike AUTH_RATE_LIMIT_MAX,
  // which only counts failed logins), so a reset-email flood is capped.
  SIGNUP_RATE_LIMIT_MAX: Joi.number().default(30),
  FORGOT_PASSWORD_RATE_LIMIT_MAX: Joi.number().default(10),
  // Swagger UI + raw spec at API_PREFIX/docs. Off by default in production.
  API_DOCS_ENABLED: Joi.boolean().when("NODE_ENV", {
    is: "production",
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),

  // ── Rate limiting ────────────────────────────────────────
  /**
   * Proxy hops in front of the app (see app.js). 1 = a single nginx/ALB, which
   * is the common case. Raise it if you add Cloudflare or another layer, or
   * every visitor will share one rate-limit bucket.
   */
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(1),
  RATE_LIMIT_WINDOW_MIN: Joi.number().default(15),
  /**
   * Blanket per-IP cap for the WHOLE API. 100/15min (~7/min) was far too tight
   * for a dashboard: one doctor opening appointments, a patient page, vitals
   * and a timeline spends dozens of requests in a minute, and a clinic behind
   * one NAT shares this bucket across every member of staff. It is a
   * denial-of-service backstop, not a usage quota.
   */
  RATE_LIMIT_MAX: Joi.number().default(600),
  /**
   * READS by a signed-in user, per user per window (separate from RATE_LIMIT_MAX,
   * which now caps anonymous traffic and all writes). One Workbench patient page
   * is ~42 requests, so this is sized for real dashboard navigation (~3/s sustained).
   */
  READ_RATE_LIMIT_MAX: Joi.number().default(3000),
  /** Print every SQL statement (development only). Off by default; slow queries are always reported. */
  DB_SQL_LOG: Joi.boolean().default(false),
  /** FAILED credential attempts per IP per window (successes don't count). */
  AUTH_RATE_LIMIT_MAX: Joi.number().default(10),
  /**
   * Token refreshes per IP per window. Deliberately generous and SEPARATE from
   * AUTH: refresh is machine-driven and every open tab spends one per window
   * just staying signed in. Sharing the login bucket is what logged people out
   * and then refused to let them back in.
   */
  REFRESH_RATE_LIMIT_MAX: Joi.number().default(120),
  // Public "Contact us" submissions per IP per window (spam cap).
  CONTACT_RATE_LIMIT_MAX: Joi.number().default(5),

  // ── File storage (doctor documents & photos) ─────────────
  // Same interface, two drivers: `local` writes to disk (zero cloud setup for
  // dev), `s3` uploads to S3. Flip STORAGE_DRIVER to switch — no code changes.
  // `cloudinary` uploads to Cloudinary (see CLOUDINARY_SETUP.md). Files stored
  // earlier under any driver keep working: the reference itself says where it lives.
  STORAGE_DRIVER: Joi.string().valid("local", "s3", "cloudinary").default("local"),
  UPLOAD_DIR: Joi.string().default("./uploads"), // local driver root
  PUBLIC_URL: Joi.string().uri().default("http://localhost:5000"), // for absolute local file URLs
  MAX_UPLOAD_MB: Joi.number().default(10),
  // S3 — required (and NON-EMPTY) only when STORAGE_DRIVER=s3 (fail fast on a
  // misconfigured prod). `.allow("")` alone would let a blank key pass `.required()`
  // — Joi's required only rejects `undefined` — so we require a non-empty string
  // when s3 and permit "" otherwise.
  S3_BUCKET: Joi.string().when("STORAGE_DRIVER", { is: "s3", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  S3_REGION: Joi.string().when("STORAGE_DRIVER", { is: "s3", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  AWS_ACCESS_KEY_ID: Joi.string().when("STORAGE_DRIVER", { is: "s3", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  AWS_SECRET_ACCESS_KEY: Joi.string().when("STORAGE_DRIVER", { is: "s3", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),

  // ── Cloudinary (STORAGE_DRIVER=cloudinary — CLOUDINARY_SETUP.md) ─────────
  // BACKEND ONLY. None of these may ever appear in a frontend or Expo env file:
  // every signature is made here and clients only ever receive finished URLs.
  // Required (non-empty) when the driver is `cloudinary`; optional otherwise, so
  // a server switched back to `local` can still read and delete what it stored
  // in Cloudinary earlier.
  CLOUDINARY_CLOUD_NAME: Joi.string().when("STORAGE_DRIVER", { is: "cloudinary", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  CLOUDINARY_API_KEY: Joi.string().when("STORAGE_DRIVER", { is: "cloudinary", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  CLOUDINARY_API_SECRET: Joi.string().when("STORAGE_DRIVER", { is: "cloudinary", then: Joi.string().min(1).required(), otherwise: Joi.string().allow("").default("") }),
  // Root folder every IHS asset sits under (one per environment, e.g. ihs-dev / ihs).
  CLOUDINARY_FOLDER: Joi.string().pattern(/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/).default("ihs"),
  // Delivery transformation for PUBLIC images only (never applied to private files).
  // Blank disables it, e.g. when the account has strict transformations on.
  CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION: Joi.string().allow("").pattern(/^[a-zA-Z0-9_,:.]*$/).default("c_limit,w_1600,f_auto,q_auto"),
  CLOUDINARY_TIMEOUT_MS: Joi.number().integer().min(1000).default(60000),

  // ── Private file links (all drivers) ─────────────────────
  // Sensitive files (records, reports, prescriptions, certificates) are never
  // handed out as storage URLs; responses carry a backend-signed
  // /api/files/<token>/<name> link instead. It lives between TTL and 2×TTL.
  FILE_URL_TTL_MINUTES: Joi.number().integer().min(1).max(24 * 60).default(60),

  // ── WhatsApp Business / Twilio (docs/follow-up-reminders-07-09-2026) ────
  WHATSAPP_PROVIDER: Joi.string().valid("twilio", "mock").default("mock"),
  TWILIO_ACCOUNT_SID: Joi.string().allow("").default(""),
  TWILIO_AUTH_TOKEN: Joi.string().allow("").default(""),
  TWILIO_WHATSAPP_FROM: Joi.string().allow("").default(""),
  TWILIO_CONTENT_TEMPLATE_SID: Joi.string().allow("").default(""),

  // ── Reminder scheduler ──────────────────────────────────────────────────
  REMINDER_SCHEDULER_ENABLED: Joi.boolean().default(true),

  // ── ICD catalogue doctors search (migration 059) ────────────────────────
  // Empty = every ACTIVE row of the admin catalogue, each result labelled with
  // its coding system + version. Set to pin doctors to one catalogue, e.g.
  // ICD_SEARCH_SYSTEM=ICD-10 ICD_SEARCH_VERSION=2019.
  ICD_SEARCH_SYSTEM: Joi.string().valid("", "ICD-10", "ICD-10-CM", "ICD-11").default(""),
  ICD_SEARCH_VERSION: Joi.string().allow("").max(30).default(""),
})
  .unknown(true) // ignore unrelated env vars (PATH, etc.)
  .prefs({ abortEarly: false, convert: true });

const { value, error } = schema.validate(process.env);

if (error) {
  const details = error.details.map((d) => `  • ${d.message}`).join("\n");
  // eslint-disable-next-line no-console
  console.error(`❌ Invalid environment configuration:\n${details}`);
  process.exit(1);
}

module.exports = Object.freeze(value);
