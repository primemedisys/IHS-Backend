# Troubleshooting

Each row links a symptom to its cause as determined from the code. "Where" names the file that produces the behaviour.

## 1. Boot / process

| Symptom | Cause and fix | Where |
|---|---|---|
| `Invalid environment configuration:` followed by bullet list, process exits 1 | A required variable is missing/malformed (`CLIENT_URL`, `DB_*`, `JWT_ACCESS_SECRET` < 32 chars, `ADMIN_EMAIL`, `ADMIN_PASSWORD`), or in production a placeholder secret / missing Razorpay, LiveKit or storage keys. Fix `.env`; all problems are listed at once | `config/env.js` |
| `Failed to start server:` + stack | DB unreachable / bad credentials / no DDL privilege for a guard. Check TCP reachability of `DB_HOST:DB_PORT` first (firewall / security-group rules, changing egress IP) before suspecting code; confirm the user can `ALTER` | `server.js` |
| JSON line `serverError` with hint "Port N is already in use" | An older API instance or orphaned dev server holds the port. Stop it or change `PORT`. (Express 5 calls the `listen` callback even on error, so a "listening" message alone proves nothing - the hint line is authoritative) | `utils/processDiagnostics.js` |
| `[process] {"level":"fatal","event":"unhandledRejection"...}` then exit | An unexpected async error; the log carries name, message and stack. Fix the cause - the process intentionally does not limp on | `processDiagnostics.install` |
| nodemon: "app crashed - waiting for file changes" | Look for the `[process]` JSON line above it for the real reason | `nodemon.json` |
| pm2 restarts the API in a loop | Usually config validation failing after a deploy introduced a new required env var; `pm2 logs ihs-backend` shows the report. Also possible: the 1 GB `max_memory_restart` during PDF rendering | `ecosystem.config.js` |
| `npm run migrate` reports nothing for `000_base_schema` or fails on missing tables | `docs/dbstruct.md` not found at `<backend>/../docs/`; the runner silently skips the base schema when the file is missing | `db/migrate.js` |
| `Data truncated for column 'role'` / unknown column errors in development after pulling | Dev DB created earlier than the code; restart (guards patch) or run `npm run migrate`. In production always run migrate | `db/ensure*`, `server.js` |

## 2. Requests

| Symptom | Cause and fix |
|---|---|
| Browser CORS error, request never reaches a route | The page's origin is not in `CLIENT_URL` (comma-separated, exact origin, scheme + host + port). Add it and restart |
| `401 TOKEN_INVALID` ("Invalid or expired access token") | Access token older than `JWT_ACCESS_TTL` (15 min) - the client must call `POST /auth/refresh`; `401 UNAUTHENTICATED` means no/malformed `Authorization: Bearer` header |
| Logged out of every tab unexpectedly | A refresh token was replayed more than 30 s after rotation (treated as theft - all sessions revoked), or the password was changed/reset (all sessions revoked by design) |
| `403 WRONG_PORTAL` | Valid credentials for a different role than the app's `audience`; use the right portal's login |
| `403 ONBOARDING_INCOMPLETE` on a clinic / blood-bank / ambulance route | Account is `pending` or `rejected` (message carries the reason) - needs admin approval; `403 "This clinic account has been suspended."` when `is_active=false` |
| `409 PHONE_SHARED` | The mobile number is on several accounts of that role; sign in / reset with the e-mail address |
| `422 VALIDATION_ERROR` with `details` | Joi rejected the body; read `details.<field>`. For multipart routes the file field name must match (`file`, `prescription`, `report`, `image`, `document`) |
| `429 RATE_LIMITED` | Global bucket (reads 3000 / writes+anonymous 600 per 15 min), login bucket (10 *failed* attempts per IP+account), or a specific limiter (signup, forgot-password, contact, PDF, patient search, access requests). All in-memory: restart clears them. Behind a proxy make sure `TRUST_PROXY_HOPS` is right - too low puts every user in one bucket |
| Public list does not show a doctor | A doctor appears only when `verification_status=approved` **and** `is_listed=true` (the admin visibility toggle; the public-listing rule is `publicListingWhere` in `doctor.service`); check `GET /admin/doctors/:id` |
| `422 PROFILE_INCOMPLETE` when booking | `phone`, `dateOfBirth`, `gender`, `city` must all be set on the patient profile |
| `422 SLOT_UNAVAILABLE` "The doctor isn't consulting that day" | No weekly window for that weekday/mode, a blocked date, the clinic is not the doctor's, or the doctor is not publicly listed |
| `422 SESSION_CLOSED` | The window for that date has already ended |
| `409 DUPLICATE_BOOKING` | The patient already holds a live token in that session |
| `409 SLOT_TAKEN` "Please try booking again" | Token collision backstop fired; retry |
| Booking stays `pending_payment` and disappears after ~10 min | Hold expiry (`hold_expired`); the patient must restart payment |
| `503 "Online payment isn't configured yet"` | Razorpay keys blank (production requires them; in dev the booking would have auto-confirmed) |
| `503 VIDEO_NOT_CONFIGURED` ("Video calling isn't configured yet") | One of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` is blank |
| `403 VIDEO_WINDOW_CLOSED` / `400` or `409 VIDEO_NOT_AVAILABLE` | Outside the join window (10 min before the slot start to 30 min after its end) -> 403; not a video booking -> 400; not yet confirmed -> 409. `409 NOT_YOUR_TURN` when the doctor is with another patient |
| `503 SMS_UNAVAILABLE` / `EMAIL_UNAVAILABLE` on OTP request | `SMS_PROVIDER=none` (default) / SMTP not configured; or the provider send failed (the code is burnt) |
| No OTP SMS in development | Use `SMS_PROVIDER=mock`; the code is printed in the API console (`SMS (mock) to ...`) |
| No e-mail at all in production | `SMTP_HOST` blank: production logs "SMTP is not configured" and sends nothing |
| Swagger 404 in production | `API_DOCS_ENABLED` defaults to false in production |
| `404 Route not found: GET /api/...` | Wrong path/prefix; consult the reference tables (e.g. patient doctors list is `/api/doctors`, not under `/patient`) |

## 3. Files

| Symptom | Cause and fix |
|---|---|
| Image/PDF link returns `403 FILE_LINK_EXPIRED` | Signed link older than 1-2 x `FILE_URL_TTL_MINUTES`; reload the page to get a fresh link |
| `404` on a `/api/files/...` link | Forged/truncated token, or the stored file is gone |
| Signed links point at `http://localhost:5000/...` | `PUBLIC_URL` not set to the API's public origin (boot warns in production with Cloudinary) |
| `422 UNSUPPORTED_FILE_TYPE` | Blocked MIME/extension (SVG, HTML, executables...) or the bytes do not match the file name (a `.pdf` that is not a PDF) |
| `422` "File is too large (max N MB)" | Raise `MAX_UPLOAD_MB` (and the proxy's body size limit) |
| `502 STORAGE_UNAVAILABLE` | Cloudinary failed or timed out (`CLOUDINARY_TIMEOUT_MS`); check credentials, cloud name, network; boot logs `Cloudinary reachable ...` when OK |
| Old uploads 404 after switching drivers | They should still load (references decide the reader). If `uploads/` was deleted, restore it; private legacy files are reachable only through signed links |
| Private S3 documents readable without a link | Expected with the S3 driver (see storage doc) - restrict the bucket |

## 4. PDFs

| Symptom | Cause and fix |
|---|---|
| `500 PDF_RENDER_FAILED` with `details.reason` | Chromium missing or failing (missing shared libraries on Linux, sandbox flags, memory). The boot log has a loud preflight error; install the libraries (runbook 6.4) or set `PUPPETEER_EXECUTABLE_PATH`; the prescription itself is already saved |
| `503 PDF_RENDER_FAILED` "PDF rendering is disabled" | `PDF_ENGINE=none` |
| Many PDF requests -> `429` | `PDF_RATE_LIMIT_MAX` per minute per doctor (default 20) |

## 5. Background jobs and realtime

| Symptom | Cause and fix |
|---|---|
| Reminders never sent | `REMINDER_SCHEDULER_ENABLED=false`; row not `pending`/`reminder_at` in the future (IST 09:00 minus interval); no patient e-mail; SMTP not configured (production); WhatsApp is in `mock` mode (default - nothing real is sent) or `twilio` selected without the `twilio` package installed (throws at first use) |
| Medicine dose notifications missing | Same scheduler flag; routine `reminder_enabled=false`; `web_reminders=false`; dose older than 30 minutes at sweep time is skipped as stale; closed mobile apps rely on local notifications, not the server |
| Socket does not connect | Token not in `handshake.auth.token`, expired token (reconnect after refresh), origin not in `CLIENT_URL`, or the proxy does not allow WebSocket upgrade (long-polling still works if reachable) |
| Notifications appear only after reload | The row was committed but the socket was offline: clients should fetch `GET /api/medicine/notifications` on `ready`/reconnect |

## 6. Tests

| Symptom | Cause and fix |
|---|---|
| "backend/.env.test is missing" | Create it (the referenced `.env.test.example` is not in the current tree) |
| "Refusing to run tests against DB_HOST=... DB_NAME=..." | Test env guard: host must be local and the DB name must end with `_test` |
| `Access denied ... to database '..._test'` | The MySQL user lacks privileges on the test database; an administrator must grant them (local only) |
| E2E suite gets 429 | Start the API under test with the large limits shown in the testing guide |
| E2E suite hits the wrong server | The chosen port is occupied by another process or a stale API - verify which process owns it |

## 7. Data questions

| Question | Answer |
|---|---|
| Where is a user's role stored? | `users.role`; profile data in `doctor_profiles` / `patient_profiles` / `clinic_profiles` / `blood_bank_profiles` / `ambulance_provider_profiles` / `pharmacy_profiles` (pharmacy accounts keep location on `users`) |
| Why does `doctorId` equal a user id? | Profile tables use `user_id` as their primary key |
| Why is an amount stored twice (booking and payment)? | `bookings.amount` is the fee at booking time; `payments.amount` the charge; commission/payout are stored at confirmation and never recomputed |
| Why can't I delete a doctor? | Deletion is refused when any dependent record exists; deactivate instead (`PATCH /admin/registry/doctors/:id/active`) |
