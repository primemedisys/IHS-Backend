# Security

This document lists the controls that are **actually implemented in the code**, followed by honest gaps. No secrets are reproduced here. Earlier hardening work is recorded in the legacy `docs-shared/legacy/PRODUCTION-READINESS-AUDIT.md` (2026-10-25); the items it marks "Fixed" for the backend were confirmed present in the current source and are included below. Items that audit left unchecked or assigned to the owner are listed in section 9 as they were found.

## 1. Transport and HTTP hardening

| Control | Where |
|---|---|
| `helmet()` default headers on every response | `app.js` |
| CORS limited to `CLIENT_URL` origins, `credentials: true`; same list for Socket.IO (native apps send no Origin header and authenticate with the token) | `app.js`, `realtime/socket.js` |
| `trust proxy` hop count configurable (`TRUST_PROXY_HOPS`) so IP-keyed limits are meaningful | `app.js` |
| JSON body limit 1 MB; multipart capped by `MAX_UPLOAD_MB` | `app.js`, `middlewares/upload.js` |
| Access log redacts `/files/<token>` (a private link is a bearer credential) | `app.js` |
| API docs off in production by default (`API_DOCS_ENABLED`) | `config/env.js` |
| Error stack hidden in production | `errorHandler.js` |
| TLS is terminated by nginx in the documented deployment, not by Node | `ecosystem.config.js` comments |

## 2. Authentication hardening
See [AUTHENTICATION-AND-AUTHORIZATION.md](AUTHENTICATION-AND-AUTHORIZATION.md). Highlights: bcrypt cost 12; refresh tokens stored only as SHA-256; rotation with reuse detection; revocation on password change/reset; per-portal role allow-lists (deny by default); `WRONG_PORTAL` checked only after authentication (no e-mail enumeration); identical response for unknown e-mail on `forgot-password`; OTP codes HMAC'd, attempt-limited, single-use; Google tokens verified for audience and verified e-mail; refusal to boot in production with the example JWT secret or admin password.

## 3. Authorization
Role gates (`authorize`), ownership as `WHERE` (404 not 403), approval gates for clinics / blood banks / ambulance providers, consent engine for doctor access to other doctors' clinical data, identity documents hidden from all non-patient readers by a model default scope, append-only audit log for sensitive reads and consent decisions, verified-doctor requirement for patient search and access requests (`DOCTOR_NOT_VERIFIED`), serializers as the single output boundary (no raw model output, so `password_hash` cannot leak).

## 4. Input validation and injection
* Joi on every body/query/param that is validated (`stripUnknown`), constants-driven enums.
* Sequelize parameterised queries; the codebase also uses ~31 raw `sequelize.query` calls for aggregates, almost all with `replacements` (98 uses). Interpolated fragments seen in review are server-computed numbers/identifiers (for example `Number(env.PASSWORD_OTP_MAX_ATTEMPTS)`); a full injection audit of every raw query was **not** performed for this document (**Unclear** for the remainder).
* Output escaping for PDFs: every doctor- or patient-supplied string passes through `esc()`; CSS values through `cssSafe()`; e-mail templates HTML-escape all interpolated values.
* Excel imports are parsed with `exceljs`, bounded (`IMPORT_MAX_ROWS` 5,000 pharmacy; `ICD_EXCEL.MAX_ROWS` 100,000 / 10 MB ICD), previewed before commit, and committed from the same re-checked file.

## 5. File upload and storage security
(Details: [FILE-STORAGE-AND-UPLOADS.md](FILE-STORAGE-AND-UPLOADS.md).)
* Allow-list of MIME types, SVG blocked, executable/markup extensions blocked even when the mimetype claims an image (stored-XSS regression test `test/security/uploadHardening.test.js`).
* Content-signature check: a `.pdf` must start like a PDF, `.docx/.xlsx/.odt/.ods` must be ZIP containers, `.doc/.xls` OLE containers, image extensions any known bitmap signature.
* Storage keys are validated (`SAFE_KEY`, no `.`/`..` segments, no backslash or NUL) and contained to the upload directory; `/uploads` serves **public** key patterns only; non-passive types are forced to download with `nosniff`.
* Private files are never returned as storage URLs: HMAC-signed, expiring `/api/files/<token>/<name>` links (TTL `FILE_URL_TTL_MINUTES`..2x), `Cache-Control: private`, `X-Robots-Tag: noindex`.
* Record deletes only touch the patient's own upload prefix; pasted record URLs must be http(s).

## 6. Payment and webhook security
* Razorpay client verify: HMAC-SHA256 of `orderId|paymentId` with the key secret, constant-time compare, **and** the order id must equal the one stored on this booking's payment (prevents replaying one valid triple against another booking).
* Webhook: HMAC over the raw body with `RAZORPAY_WEBHOOK_SECRET` (503 when the secret is empty so an empty-key HMAC cannot be forged); only `payment.captured` / `order.paid` confirm; `payment.failed` cannot; confirmation is idempotent.
* LiveKit webhook: signed JWT verified by `WebhookReceiver`; always 200.
* Secrets (Razorpay secret, LiveKit secret, Cloudinary secret) are never sent to clients; only `RAZORPAY_KEY_ID` and `LIVEKIT_URL` are public values.
* Medicine "online" payment is a simulation and is **refused in production**; UPI-QR payments are never auto-verified (the provider confirms receipt).

## 7. Abuse controls
Rate limiting (12 limiters, see the middleware document); per-number OTP limits; per-doctor limits on patient search, record-access requests, PDF renders, shared-catalogue additions; contact-form IP cap; duplicate-booking guard; token-collision DB constraint; row-locked reservations in blood bank and pharmacy stock.

## 8. Data protection
* Patient identity documents (Aadhaar etc.) kept out of every non-patient read; the number is masked to the last 4 digits.
* Doctor-to-patient access to other doctors' sensitive records needs patient consent with exact documents and an expiry; every decision and download is audited.
* Admin deletion of patients/doctors is previewed and runs in a single transaction (doctor deletion refused if any trail exists).
* Testimonial photos require an explicit consent flag.
* Logs: SQL statements are not printed by default (they can carry patient data).
* Prescription numbers are gapless and signed prescriptions immutable.

## 9. Known gaps and risks (as found)

| # | Finding | Status |
|---|---|---|
| 1 | Access JWTs cannot be revoked before expiry (<= 15 min); `authenticate` does not read the DB | Known design trade-off |
| 2 | Rate limiters use the in-memory store: reset on restart, not shared between processes (pm2 runs one instance, so currently acceptable) | Known |
| 3 | Signed `/api/files` links are bearer credentials until they expire; revoking record access stops new links immediately but already-issued links work until expiry (`CLOUDINARY_SETUP.md` says the same) | Known |
| 4 | Approved clinics can open **any** registered patient (`resolveClinicPatient` checks existence only, by design); the code comments name a future "clinic-patient link" phase | Product decision / Planned |
| 5 | No refund path exists; no account lockout other than rate limiting; no MFA | Not implemented |
| 6 | `/uploads` static route still exists for public images when the local driver is used | By design |
| 7 | The 2026-10-25 audit left unchecked backend items: reset-link origin, no Ethereal in production, mail HTML escaping, signup/forgot rate limits, docs gating, placeholder-secret refusal, WhatsApp mock-mode PII log, consent doctor-verification re-check. Current code shows reset/OTP limits, docs gating, placeholder refusal, no-Ethereal-in-production and escaped templates **are** implemented; the WhatsApp mock log and any remaining items were not re-verified (**Unclear**) | Partially verified |
| 8 | The audit flagged tracked files with a Maps key and uploaded KYC files in git history of other branches (repository-level, outside `backend/src`) | Owner action (outside this documentation scope) |
| 9 | Several `ensure*` guards and the migration runner need DDL privileges; the application DB user is therefore powerful | Operational |
| 10 | `cookie-parser` is installed but unused for auth; harmless but unnecessary surface | Minor |

## 10. Security-related tests
`test/security/globalLimiterAuthRoutes.test.js`, `readWriteLimiter.test.js` (DB-free), `uploadHardening.test.js` (end-to-end), `test/storage/cloudinaryStorage.test.js` (signed links, `/uploads` protection), consent suites (`recordAccess`, `clinicalConsent`, `medicalDocuments`). See [TESTING-GUIDE.md](TESTING-GUIDE.md).
