# Tech Stack and Dependencies

Source: `backend/package.json` (version ranges) and the installed `node_modules` versions where noted. Module system: **CommonJS** (`"type": "commonjs"`). There is no `engines` field; CI (`Jenkinsfile`) uses the Jenkins tool `node20`, and development was done on Node 22 (local `node -v` = 22.18). Native `fetch` is used by `sms.service.js` (Node 18+).

## 1. Runtime dependencies

| Package | Range | Installed | Used in | Purpose |
|---|---|---|---|---|
| express | ^5.2.1 | 5.2.1 | `app.js`, all routers | HTTP framework. Express 5 specifics handled in code: `req.query` is a getter (hence `validateQuery` -> `req.validatedQuery`); `listen` callback receives errors (hence `processDiagnostics.watchServer`) |
| sequelize | ^6.37.8 | 6.37.8 | `models/`, `services/` | ORM (MySQL dialect, `underscored`, `freezeTableName`, `timestamps: false`) |
| mysql2 | ^3.22.5 | - | Sequelize + `db/migrate.js` | MySQL driver (migrate.js connects with `multipleStatements`) |
| joi | ^17.13.3 | - | `config/env.js`, `validators/` | Env and request validation |
| jsonwebtoken | ^9.0.2 | - | `token.service.js`, `utils/accessToken.js` | HS256 access tokens |
| bcryptjs | ^2.4.3 | - | `utils/password.js` | Password hashing (`BCRYPT_COST = 12`) |
| helmet | ^8.0.0 | - | `app.js` | Security headers |
| cors | ^2.8.5 | - | `app.js` | Origin allow-list from `CLIENT_URL` |
| cookie-parser | ^1.4.7 | - | `app.js` | Parses cookies (no route was found that sets or reads a cookie - **Unclear** whether it is still needed) |
| express-rate-limit | ^7.4.1 | - | `middlewares/rateLimiters.js` | 12 limiters, in-memory store |
| morgan | ^1.10.0 | - | `app.js` | Access log (`dev` in development, `combined` otherwise) with `/files/<token>` redacted |
| multer | ^2.2.0 | - | `middlewares/upload.js` | Multipart parsing into memory (`MAX_UPLOAD_MB`) |
| dotenv | ^16.4.5 | - | `config/env.js` | Loads `.env` from the process working directory |
| nodemailer | ^6.9.16 | - | `mail.service.js` | SMTP; Ethereal fallback in dev |
| cloudinary | ^2.11.0 | - | `config/cloudinary.js`, `cloudinaryStorage.service.js` | Cloudinary storage driver (lazy) |
| @aws-sdk/client-s3 | ^3.1079.0 | - | `upload.service.js` | S3 storage driver |
| puppeteer | ^25.3.0 | 25.3.0 | `prescriptionPdf.service.js` | Headless Chromium prescription PDFs. CI sets `PUPPETEER_SKIP_DOWNLOAD=true` for lint-only builds; production needs Chromium libraries (see Jenkins runbook) |
| razorpay | ^2.9.6 | - | `payment.service.js` | Order creation and signature helpers |
| livekit-server-sdk | ^2.17.0 | - | `livekit.service.js` | Join tokens + `WebhookReceiver` |
| socket.io | ^4.8.4 | - | `realtime/socket.js` | Notification push |
| exceljs | ^4.4.0 | - | `pharmacyImport.service.js`, `icdImport.service.js` | Excel templates, preview/import, export |
| google-auth-library | ^9.15.0 | - | `google.service.js` | Verifies Google ID tokens (`OAuth2Client.verifyIdToken`) |
| swagger-ui-express | ^5.0.1 | - | `app.js` | Serves the hand-written OpenAPI spec |

## 2. Dev dependencies

| Package | Use |
|---|---|
| nodemon ^3.1.7 | `npm run dev` |
| socket.io-client ^4.8.4 | Socket.IO assertions in `test/recordAccess` and `test/patientMedicine` |

Tests use the Node built-in runner (`node --test`) and `node:assert`; there is no Jest/Mocha/Supertest.

## 3. Not declared but required in some configurations

| Package | Why it matters |
|---|---|
| `twilio` | `services/whatsapp.service.js` does `require("twilio")` lazily when `WHATSAPP_PROVIDER=twilio` and `TWILIO_ACCOUNT_SID` is set. It is **not** in `package.json` and was not found in `node_modules`, so real WhatsApp sending would throw at first use until the package is installed. SMS (`sms.service.js`) does not use the SDK - it calls Twilio's REST API with `fetch`. |
| A Chromium install | Needed by Puppeteer at runtime unless `PDF_ENGINE=none`; `PUPPETEER_EXECUTABLE_PATH` can point to a system Chromium. |

## 4. Infrastructure and external services

| Service | Used for | Required when |
|---|---|---|
| MySQL 8-class server (InnoDB, utf8mb4) | Everything | always. The code uses stored generated columns, `FOR UPDATE SKIP LOCKED`, `CONVERT_TZ` with a fixed offset |
| Razorpay | Online consultation payment | production (keys required by env validation) |
| LiveKit (Cloud or self-hosted) | Video rooms | production (keys required) |
| Cloudinary or S3 or local disk | File storage | per `STORAGE_DRIVER` |
| SMTP server | Password reset, contact notification, prescription-ready, follow-up reminders | production should set `SMTP_*`; dev falls back to Ethereal |
| Twilio | SMS OTP; WhatsApp reminders | optional |
| Google Identity | Google sign-in | optional (`GOOGLE_CLIENT_ID`) |
| nginx + pm2 | TLS termination and process supervision | deployment (pm2 definitions in `ecosystem.config.js`) |

Google Maps is **not** called by the backend (location data is stored as lat/lng/address text sent by clients; distance maths is done in SQL / `utils/geo.js`).

## 5. Version-sensitive behaviours worth knowing

* Express 5 path syntax: wildcards and optional params differ from Express 4; the routers here use only plain `:param` segments.
* Sequelize `underscored: true` + `timestamps: false`: models declare `createdAt` / `updatedAt` themselves where they exist.
* `multer` 2.x is used with `memoryStorage`: uploads are fully buffered (limit `MAX_UPLOAD_MB`, default 10).
* `express.json` limit is 1 MB; bulk ICD import therefore sends rows in chunks of <= 500 (`ICD_IMPORT_MAX_ROWS`), while Excel import uses multipart.
