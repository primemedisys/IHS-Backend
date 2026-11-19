# Middleware, Validation and Error Handling

## 1. Global middleware order (`app.js`)

`helmet` -> `cors({ origin: CLIENT_URL list, credentials: true })` -> `express.json({ limit: "1mb", type: ["application/json", "application/webhook+json"], verify: captures req.rawBody })` -> `urlencoded({ extended: true })` -> `cookie-parser` -> `morgan` (custom `url` token redacting `/files/<token>`) -> `/uploads` static (conditional) -> Swagger (conditional) -> `API_PREFIX` + `globalLimiter` + `routes` -> `notFound` -> `errorHandler`.

## 2. Route-level middleware

| Middleware | File | Behaviour |
|---|---|---|
| `validate(schema, property = "body")` | `middlewares/validate.js` | Joi `abortEarly:false, stripUnknown:true, convert:true`; replaces `req[property]` with the coerced value; failure -> `ApiError(422, "Validation failed", { code: VALIDATION_ERROR, details: { "<field.path>": [messages without quotes] } })` |
| `validateQuery(schema)` | `middlewares/validateQuery.js` | Same options, but stores the result on `req.validatedQuery` because in Express 5 `req.query` is a getter without a setter. Controllers read `req.validatedQuery` |
| `authenticate`, `authorize` | see authentication doc | |
| `upload.single(field, { required = true })` | `middlewares/upload.js` | multer memory storage, `MAX_UPLOAD_MB` limit. Multer errors become 422 (`File is too large (max N MB)`); missing file -> 422 "A file is required" unless `required:false` |
| `resolveDoctorId`, `resolveClinicPatient` | | normalise "who is the target" into `req.doctorId` / `req.patientId` |
| `requireApproved*` | | approval and active gates; set `req.clinicId` / `req.bloodBankId` / `req.providerId` |
| rate limiters | `middlewares/rateLimiters.js` | see section 5 |

Multipart ordering rule used in routes: `upload.single(...)` **before** `validate(...)` whenever the body schema reads multipart text fields (`req.body` only exists after multer ran).

## 3. Upload filter (`middlewares/upload.js`)

Allowed: any `image/*` except `image/svg+xml`; `application/pdf`; Word (`msword`, `docx`, `odt`, `rtf`), `text/plain`; Excel/CSV/ODS (`ms-excel`, `xlsx`, `ods`, `text/csv`); `application/dicom`. Refused extensions regardless of declared mimetype: `html htm xhtml shtml svg svgz xml xsl js mjs cjs php exe bat cmd sh msi jar`. Failure: `422 UNSUPPORTED_FILE_TYPE`. A second, content-based check (`utils/fileSignature.assertContentMatchesName`) runs inside `upload.service.put` (see the storage document).

## 4. Validation (`validators/`)

* 33 Joi modules, one per domain; the single place request shape is validated (controllers trust `req.body`).
* Vocabulary comes from `config/constants.js` (`BOOKING_MODES`, `ACQUISITION_SOURCES`, `MEDICINE_ROUTES`, ...), so validators, services and Swagger cannot drift.
* Shape rules only; business rules (is the doctor consulting that day? is the profile complete?) live in services.
* Notable rules: password policy (8-128, letter + digit); Indian mobile numbers coerced to 10 digits; `partialOf(createSchema)` for PATCH of portfolio sections; `clinicId` required for clinic bookings and forbidden for video; `offlineMethod=upi_qr` requires `paymentMode=offline`.
* Environment variables are validated the same way at boot (`config/env.js`).

## 5. Rate limiters (`middlewares/rateLimiters.js`, all `express-rate-limit`, in-memory store)

| Limiter | Applies to | Key | Window / max (defaults) |
|---|---|---|---|
| `readLimiter` (in `globalLimiter`) | GET/HEAD by a **signed-in** user (token signature verified, no DB) | `u:<userId>` | 15 min / `READ_RATE_LIMIT_MAX` 3000 |
| `writeLimiter` (in `globalLimiter`) | anonymous traffic and every write | `u:<userId>` else IP | 15 min / `RATE_LIMIT_MAX` 600 |
| `authLimiter` = IP bucket + account bucket | login, Google, reset-password, OTP verify | `ip|credential` and `ip` | counts **failed** attempts only (`skipSuccessfulRequests`): `AUTH_RATE_LIMIT_MAX` 10 per IP+account, 5x that per IP |
| `refreshLimiter` | `POST /auth/refresh` | IP | `REFRESH_RATE_LIMIT_MAX` 120 |
| `signupLimiter` | register routes | IP | `SIGNUP_RATE_LIMIT_MAX` 30 (counts every request) |
| `forgotPasswordLimiter` | forgot-password and OTP request | IP | `FORGOT_PASSWORD_RATE_LIMIT_MAX` 10 |
| `contactLimiter` | contact form | IP | `CONTACT_RATE_LIMIT_MAX` 5 |
| `pdfLimiter` | prescription preview/finalize, consented record file | doctor id | 1 min / `PDF_RATE_LIMIT_MAX` 20 |
| `patientSearchLimiter` | doctor patient search | doctor id | 1 min / `PATIENT_SEARCH_RATE_LIMIT_MAX` 20 |
| `accessRequestLimiter` | record-access requests | doctor id | 1 h / `ACCESS_REQUEST_RATE_LIMIT_MAX` 20 |
| `subSpecCreateLimiter` | doctor adds a shared sub-specialty | doctor id | 1 h / 20 (hard-coded) |

The sign-in/recovery/register POST routes listed in `OWN_LIMITER_ROUTES` are **skipped** by the global limiters so that ordinary traffic can never make a login fail with 429 before its own limiter is consulted. All limiters answer `429 RATE_LIMITED` ("Too many requests, please try again later") through the standard envelope; standard `RateLimit-*` headers are sent where enabled. Because the store is in memory, counts are per process and reset on restart; behind a proxy the client IP depends on `TRUST_PROXY_HOPS`.

## 6. Error handling (`middlewares/errorHandler.js`, `utils/ApiError.js`, `utils/asyncHandler.js`)

* `ApiError(statusCode, message, { code, details })` with helpers `badRequest, unauthorized, forbidden, notFound, conflict, invalidCredentials`.
* `asyncHandler(fn)` forwards rejected promises to Express (no per-controller try/catch).
* `errorHandler` mapping: `ApiError` -> its own status/code/details; Sequelize `UniqueConstraintError` -> `409` `"<field> is already in use"` with code `EMAIL_IN_USE` (note: that code is used for *any* unique violation); Sequelize `ValidationError` -> `422 VALIDATION_ERROR` with per-field details; anything else -> `500 INTERNAL` "Something went wrong". Status >= 500 logs the error server-side; the response includes `stack` **only when `NODE_ENV != production`**.
* Envelope: `{ "error": { "message", "code?", "details?" } }` (undefined keys removed).

### Error codes (`ERROR_CODES` in `config/constants.js`)

| Group | Codes |
|---|---|
| Generic | `VALIDATION_ERROR, INVALID_CREDENTIALS, WRONG_PORTAL, EMAIL_IN_USE, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, TOKEN_INVALID, RATE_LIMITED, INTERNAL` |
| OTP / phone | `PHONE_SHARED, OTP_INVALID, SMS_UNAVAILABLE, EMAIL_UNAVAILABLE` |
| Doctor onboarding | `REG_NUMBER_IN_USE, ONBOARDING_INCOMPLETE, DOC_REQUIRED, UNSUPPORTED_FILE_TYPE` |
| Storage | `STORAGE_UNAVAILABLE, FILE_LINK_EXPIRED` |
| Booking / queue | `PROFILE_INCOMPLETE, SLOT_TAKEN, SLOT_UNAVAILABLE, SESSION_FULL, SESSION_CLOSED, SESSION_NOT_FOUND, DUPLICATE_BOOKING, NOT_YOUR_TURN, QUEUE_ALREADY_SERVING, STATUS_IN_USE, PAYMENT_VERIFICATION_FAILED, BOOKING_NOT_PAYABLE` |
| Prescriptions / catalogue | `TEMPLATE_NOT_FOUND, TEMPLATE_IN_USE, RX_ALREADY_EXISTS, MEDICINE_DUPLICATE, CATALOGUE_DUPLICATE, ICD_DUPLICATE, ICD_INACTIVE, ICD_IMPORT_STALE, RX_NOT_EDITABLE, RX_BOOKING_NOT_ELIGIBLE, PDF_RENDER_FAILED` |
| Patient medicines | `PATIENT_MEDICINE_NOT_EDITABLE, PRESCRIBED_FIELD_LOCKED, DOSE_ALREADY_TAKEN, DOSE_NOT_ACTIONABLE` |
| Referrals | `REFERRAL_NOT_FOUND, REFERRAL_TARGET_INVALID, REFERRAL_NOT_CANCELLABLE, REFERRAL_ALREADY_LINKED, JOURNEY_NOT_FOUND` |
| Video | `VIDEO_NOT_AVAILABLE, VIDEO_WINDOW_CLOSED, VIDEO_NOT_CONFIGURED` |
| Medicine | `CART_EMPTY, STOCK_UNAVAILABLE, PAYMENT_FAILED, ORDER_NOT_PAYABLE, INVALID_STATUS_TRANSITION, PAYMENT_QR_UNAVAILABLE, PAYMENT_NOT_PENDING` |
| Ambulance | `VEHICLE_IN_USE, AMBULANCE_UNAVAILABLE, OUTSIDE_SERVICE_AREA, DRIVER_BUSY` |
| Consent | `ACCESS_ALREADY_AUTHORIZED, ACCESS_REQUEST_PENDING, ACCESS_REQUEST_CLOSED, ACCESS_NOT_GRANTED, DOCTOR_NOT_VERIFIED, ACCESS_REQUEST_COOLDOWN` |

Some services also throw plain `ApiError`s with no code (for example "Doctor not found"); clients should rely on HTTP status when `code` is absent.

## 7. Logging

`morgan` access logs (`dev` format in development, `combined` otherwise; file tokens redacted); `console.*` for application logs (emoji-prefixed boot lines, `[error]`, `[sql:slow ...]`, `[video]`); `processDiagnostics` emits one JSON line per fatal event. There is no structured logger, no log levels, no log shipping; pm2 captures stdout/stderr to `<root>/logs/<name>.out.log` / `.err.log`. The older `backend/docs/feature-history/logger.md` is a development session log, not a logging guide.
