# Environment Configuration

All configuration is read **once** in `src/config/env.js`: `dotenv.config()` (from the process working directory - pm2 therefore sets `cwd` to `<root>/backend`), then a Joi schema validates `process.env`, applies defaults and coerces types, and the result is exported as a **frozen** object. On any error the process prints every problem and exits with code 1 - the API never boots half-configured. Unknown variables are ignored. No other source file reads `process.env` (verified by grep; only `config/env.js` and test helpers do).

Only `.env.example` was read for this document. Never commit a real `.env`. Values below are defaults or placeholders - no real secrets appear here.

`.env.example` documents 57 of the 78 variables; the 21 it omits are marked **(not in .env.example)**.

## 1. Server

| Variable | Default | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | no | `development` / `test` / `production`. `development` enables `sequelize.sync()`, dev parity shims, the dev booking payment bypass and Swagger by default |
| `PORT` | `5000` | no | Listen port. The dev server on the deploy host is documented to use 5001 via its own `.env` |
| `API_PREFIX` | `/api` | no | Mount prefix of every route (also used by file links and Swagger server URL) |
| `CLIENT_URL` | - | **yes** | Comma-separated list of origins (each must be a valid URL). Used for CORS, Socket.IO CORS, the first entry (the patient app must be first) is the base of password-reset links and of the video `meetLink` (`<first origin>/dashboard/appointments/<bookingId>/call`) |
| `TRUST_PROXY_HOPS` | `1` | no | 0-5. Proxy hops in front of the app; wrong value collapses all clients into one rate-limit bucket (too low) or allows spoofing (too high) |
| `API_DOCS_ENABLED` | `true` (dev/test) / `false` (production) | no **(not in .env.example)** | Serves Swagger UI at `<API_PREFIX>/docs` and the spec at `<API_PREFIX>/docs.json` |

## 2. Database (MySQL)

| Variable | Default | Required |
|---|---|---|
| `DB_HOST` | - | **yes** |
| `DB_PORT` | `3306` | no |
| `DB_NAME` | - | **yes** (`migrate.js` creates it if missing) |
| `DB_USER` | - | **yes** |
| `DB_PASSWORD` | - | **yes** (empty string allowed) |
| `DB_SQL_LOG` | `false` | no. Prints every SQL statement in development only; statements slower than 500 ms are always warned |

## 3. Authentication and admin seed

| Variable | Default | Required | Notes |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | - | **yes** | min 32 chars; in production the `.env.example` placeholder is rejected. Also keys the HMACs for OTP codes and file links |
| `JWT_ACCESS_TTL` | `15m` | no | passed to `jsonwebtoken` `expiresIn` |
| `JWT_REFRESH_TTL_DAYS` | `30` | no | refresh-token row expiry |
| `ADMIN_NAME` | `Platform Admin` | no | |
| `ADMIN_EMAIL` | - | **yes** | seeded admin identity; contact-form notifications are sent to it |
| `ADMIN_PASSWORD` | - | **yes** | min 8; the example password is rejected in production. Hashed at boot; re-hashed if changed |
| `GOOGLE_CLIENT_ID` | `""` | no | blank disables Google sign-in (the endpoint answers 400 "not configured") |
| `RESET_TOKEN_TTL_MINUTES` | `45` | no | e-mail reset link lifetime |
| `PASSWORD_OTP_TTL_MINUTES` | `10` | no | 1-30 |
| `PASSWORD_OTP_MAX_ATTEMPTS` | `5` | no | 1-10; the last wrong attempt burns the code |
| `PASSWORD_OTP_MAX_PER_HOUR` | `5` | no | per phone/e-mail, rolling hour |
| `PASSWORD_OTP_RESEND_SECONDS` | `60` | no | minimum gap between two codes |
| `DOCTOR_APP_URL` | `""` | no **(not in .env.example)** | when set, a doctor's e-mail reset link opens the doctor site instead of the first `CLIENT_URL` |

## 4. E-mail, SMS, WhatsApp

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` / `SMTP_PORT` (587) / `SMTP_SECURE` (false) / `SMTP_USER` / `SMTP_PASSWORD` | blank | blank host: dev uses an Ethereal test inbox and logs the preview URL; **production sends no e-mail and logs an error** |
| `MAIL_FROM` | `Indian Health System <no-reply@localhost>` | |
| `SMS_PROVIDER` | `none` | `none` (OTP endpoint answers 503), `mock` (prints the SMS to the console; refused when `NODE_ENV=production`), `twilio` |
| `TWILIO_SMS_FROM` | `""` | sender for SMS |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `""` | **(not in .env.example)** used by SMS (REST via fetch) and WhatsApp (SDK) |
| `WHATSAPP_PROVIDER` | `mock` | **(not in .env.example)** `mock` logs; `twilio` requires the undeclared `twilio` npm package |
| `TWILIO_WHATSAPP_FROM`, `TWILIO_CONTENT_TEMPLATE_SID` | `""` | **(not in .env.example)** WhatsApp sender and approved template |
| `REMINDER_SCHEDULER_ENABLED` | `true` | **(not in .env.example)** `false` disables both in-process schedulers (follow-up reminders and medicine reminders) |

## 5. Payments and video

| Variable | Default / production rule | Notes |
|---|---|---|
| `RAZORPAY_KEY_ID` | blank in dev; **required non-empty in production** | the only Razorpay value ever sent to a client |
| `RAZORPAY_KEY_SECRET` | same | server only |
| `RAZORPAY_WEBHOOK_SECRET` | same | must equal the dashboard webhook secret; events `payment.captured` + `order.paid`, URL `/api/webhooks/razorpay` |
| `LIVEKIT_URL` | blank in dev; production requires a `ws`/`wss` URI | public SFU URL, echoed to clients |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | blank in dev; required in production | server only; mint tokens + verify the webhook at `/api/webhooks/livekit` |

Blank Razorpay keys in development: online consultation bookings auto-confirm with a synthetic successful payment (a dev-only bypass in `booking.service.js`; never in production). Blank LiveKit keys: `VIDEO_NOT_CONFIGURED` (503) from the token endpoint; everything else works.

## 6. Prescription PDF

| Variable | Default | Notes |
|---|---|---|
| `PDF_ENGINE` | `puppeteer` | `none` disables rendering (CI/test) **(not in .env.example)** |
| `PDF_TIMEOUT_MS` | `15000` | **(not in .env.example)** |
| `PDF_MAX_CONCURRENCY` | `2` | **(not in .env.example)** concurrent Chromium pages |
| `PUPPETEER_EXECUTABLE_PATH` | `""` | **(not in .env.example)** system Chromium path; blank = bundled |
| `RX_NUMBER_PREFIX` | `RX` | **(not in .env.example)** fallback prefix when a template sets none |
| `PDF_RATE_LIMIT_MAX` | `20` | **(not in .env.example)** renders / minute / doctor |

## 7. Rate limiting

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_WINDOW_MIN` | `15` | window for all limiters except PDF/search/request limiters |
| `RATE_LIMIT_MAX` | `600` | anonymous traffic (per IP) and every write (per signed-in user, else IP) |
| `READ_RATE_LIMIT_MAX` | `3000` | signed-in reads per user per window |
| `AUTH_RATE_LIMIT_MAX` | `10` | FAILED logins per IP+account per window (per-IP across accounts: 5x) |
| `REFRESH_RATE_LIMIT_MAX` | `120` | token refreshes per IP per window |
| `SIGNUP_RATE_LIMIT_MAX` | `30` | **(not in .env.example)** registrations / Google sign-in |
| `FORGOT_PASSWORD_RATE_LIMIT_MAX` | `10` | **(not in .env.example)** reset e-mails / OTP requests |
| `CONTACT_RATE_LIMIT_MAX` | `5` | **(not in .env.example)** contact-form submissions |
| `PATIENT_SEARCH_RATE_LIMIT_MAX` | `20` | **(not in .env.example)** doctor patient-search per minute per doctor |
| `ACCESS_REQUEST_RATE_LIMIT_MAX` | `20` | **(not in .env.example)** record-access requests per hour per doctor |

(`.env.example` does list `RATE_LIMIT_WINDOW_MIN`, `RATE_LIMIT_MAX`, `READ_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`, `REFRESH_RATE_LIMIT_MAX`, `TRUST_PROXY_HOPS`, `DB_SQL_LOG`.)

## 8. File storage

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` / `s3` / `cloudinary`; picks where NEW files go; reads/deletes follow the stored reference |
| `UPLOAD_DIR` | `./uploads` | local driver root (relative to cwd) |
| `PUBLIC_URL` | `http://localhost:5000` | the API's public origin; used to build `/api/files/...` links and absolute local URLs. In production with Cloudinary a localhost value triggers a boot warning |
| `MAX_UPLOAD_MB` | `10` | multer limit |
| `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | blank | **required non-empty only when** `STORAGE_DRIVER=s3` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | blank | **required only when** `STORAGE_DRIVER=cloudinary`. Backend only - never put in a frontend/mobile env |
| `CLOUDINARY_FOLDER` | `ihs` | root folder; pattern `[a-zA-Z0-9_-]+(/...)*`; use one per environment |
| `CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION` | `c_limit,w_1600,f_auto,q_auto` | delivery transformation for **public** images only; blank disables |
| `CLOUDINARY_TIMEOUT_MS` | `60000` | min 1000 |
| `FILE_URL_TTL_MINUTES` | `60` | 1-1440; signed file links live between TTL and 2x TTL |

## 9. ICD search

| Variable | Default | Notes |
|---|---|---|
| `ICD_SEARCH_SYSTEM` | `""` | `""`, `ICD-10`, `ICD-10-CM`, `ICD-11` - pins the doctor diagnosis search to one catalogue **(not in .env.example)** |
| `ICD_SEARCH_VERSION` | `""` | max 30 chars **(not in .env.example)** |

## 10. Environment profiles

| Profile | Typical values | Behaviour differences |
|---|---|---|
| Local dev | `NODE_ENV=development`, local MySQL, `STORAGE_DRIVER=local`, blank Razorpay/LiveKit, `SMS_PROVIDER=mock` | `sequelize.sync()` + shims at boot; Ethereal mail; booking payment bypass; Swagger on |
| Test (`backend/.env.test`, not committed) | `DB_HOST` localhost, `DB_NAME` ending `_test` | `test/testEnv.js` forces `NODE_ENV=test`, `STORAGE_DRIVER=local`, huge rate limits, refuses non-local DBs |
| Production | `NODE_ENV=production` set explicitly (the default is development) | placeholders refused; Razorpay + LiveKit keys required; no Ethereal; Swagger off; simulated medicine online payment refused; `mock` SMS refused |

The deploy host keeps separate `backend/.env` files for production and the dev instance; they are never rsynced/committed (`Jenkinsfile`, `ecosystem.config.js` comments).

## 11. Environment variables used only by tests / scripts

`PHARMACY_E2E_BASE_URL`, `MEDICAL_DOCS_E2E_BASE_URL`, `WORKBENCH_RX_E2E_BASE_URL`, `SECURITY_E2E_BASE_URL`, `RECORD_ACCESS_E2E_BASE_URL`, `PORTFOLIO_E2E_BASE_URL`, `PAYMENT_E2E_BASE_URL`, `MEDICINE_E2E_BASE_URL`, `DIAGNOSTIC_E2E_BASE_URL`, `DASHBOARD_E2E_BASE_URL`, `CONSENT_E2E_BASE_URL` (point a suite at an already-running API), `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD` (`test/testEnv.js`). See [TESTING-GUIDE.md](TESTING-GUIDE.md).
