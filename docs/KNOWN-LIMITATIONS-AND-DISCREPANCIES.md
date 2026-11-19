# Known Limitations and Discrepancies with Earlier Documentation

Status vocabulary: **Implemented (verified)**, **Partially implemented**, **Documented-but-not-found**, **Planned**, **Unclear**. Everything here was determined by reading the source in `backend/`; nothing was executed.

## Part A. Known limitations of the backend

### A.1 Payments and money
| # | Limitation | Evidence | Status |
|---|---|---|---|
| 1 | **No refund path.** Cancelling a paid, confirmed booking never calls Razorpay or sets `payments.status = refunded`; `refunded_at` / `refund_amount` columns and the earnings/analytics readers exist, but no writer was found | `booking.cancel`; grep for refund writers in services | Documented-but-not-found (as a feature) |
| 2 | Doctor payouts are bookkeeping only: `commission_amount` and `doctor_payout_amount` are stored at confirmation (15 %, `PLATFORM_COMMISSION_PCT`); nothing transfers money | `payment.service.applySplit` | By design / not implemented |
| 3 | Medicine "online" payment is a **simulation** (`gateway = simulated`, client-chosen outcome) and is refused in production; only COD and provider UPI QR work in production | `medicineOrderGroup.service`, constants | Partially implemented |
| 4 | UPI QR payments are never verified automatically; the provider must confirm | design | By design |
| 5 | Dev-only booking payment bypass exists: with `NODE_ENV != production` and no Razorpay keys, online bookings confirm instantly | `booking.service.create` | Dev behaviour |
| 6 | Doctor-initiated reschedule intentionally skips the duplicate-booking guard (a patient can end up with two tokens on one day) | documented in `docs-shared/legacy/IMPLEMENTATION-STATUS.md`; reschedule path comment | By design |

### A.2 Identity and security
| # | Limitation | Status |
|---|---|---|
| 7 | Access JWTs cannot be revoked before expiry (<= 15 min); `authenticate` never reads the DB | Known trade-off |
| 8 | All rate limiters are in-memory (reset on restart, per process) | Known |
| 9 | E-mail verification is never sent: `mail.sendVerifyEmail` and its template exist but nothing calls them; `users.is_email_verified` becomes true only through Google sign-in or the admin seed | Documented-but-not-found |
| 10 | No MFA, no account lockout beyond rate limiting | Not implemented |
| 11 | Approved clinics can open any registered patient (`resolveClinicPatient` checks only that the patient exists); the code comments describe a future "clinic-patient link" phase | Product decision / Planned |
| 12 | Signed `/api/files` links are bearer credentials until expiry; revoking consent stops new links only | Known |
| 13 | Any Sequelize unique-constraint violation is reported with code `EMAIL_IN_USE` (message names the field) | Minor |
| 14 | `cookie-parser` is mounted but no cookies are used | Minor |

### A.3 Platform and operations
| # | Limitation | Status |
|---|---|---|
| 15 | **S3 driver is outside the signed-link model**: S3 URLs are returned unchanged by the JSON replacer and read with an unauthenticated fetch; private medical files on S3 depend on bucket policy | Partially implemented |
| 16 | **WhatsApp sending needs the `twilio` npm package, which is not in `package.json`** (lazy `require`); default provider is `mock`, in which "sent" is recorded without sending | Partially implemented |
| 17 | In-app notifications only: Socket.IO reaches open pages/apps; there is no OS push (FCM/APNs) and no SMS/e-mail for blood, ambulance, pharmacy, diagnostic events | Not implemented |
| 18 | Ambulance: no live GPS tracking (status + ETA, clients poll), no online payment, no provider document upload | By design (module docs) |
| 19 | Single process only (`instances: 1`): boot-time seeds, schema patches and in-process schedulers assume one writer | Operational constraint |
| 20 | No automated tests in CI/CD: GitHub Actions deploys on push; the superseded Jenkinsfile only ran `node --check`. In-process test suites need `.env.test` and a local DB grant that was missing on at least one machine | Gap |
| 21 | Schema management: forward-only SQL, no down-migrations, no checksums; duplicate prefix `012`, no 041/042; boot guards exist for only some migrations (see migrations doc) | Gap |
| 22 | `migrate.js` silently skips the base schema if `docs/dbstruct.md` is missing | Gap |
| 23 | Application DB user needs DDL privileges (guards run `ALTER TABLE`) | Operational |
| 24 | Prescription PDF rendering depends on a Chromium install and ~1 GB process memory headroom | Operational |
| 25 | Logging is `console.*` + morgan; no log levels, no shipping; `/api/health` is a static `ok` (no DB check) | Gap |
| 26 | Read caps: treatment timeline 200 rows, roster 500, doctor map 500 pins, workbench lists 300/100 (all flagged `capped` where applicable); no paging beyond | By design |
| 27 | Swagger spec is hand-written and may lag the routers (the route tables in this folder were generated from the router source) | Unclear completeness |

### A.4 Features present in the base schema or docs but absent from the code
| Item | Status |
|---|---|
| Doctor reviews / ratings (`reviews` table; `avg_rating`, `rating_count` columns exist and are read by search, nothing writes them) | Documented-but-not-found |
| Family members (`family_members`; `bookings.family_member_id` never written) | Documented-but-not-found |
| Doctor bank details, symptom-to-specialization map, `email_notifications` log | Documented-but-not-found (no model/route) |
| Booking approval by the doctor (`POST /doctor/bookings/:id/confirm|reject`, "patient-booking-flow" proposal) | Documented-but-not-found |
| `GET /vitals/ranges` (vitals reference ranges endpoint) | Documented-but-not-found: ranges are applied server-side in serializers via `config/vitalsRanges.js` |
| `PATCH /admin/doctors/:id/status`, `POST /admin/doctors/:id/reset-password` (admin-portal backend plan) | Documented-but-not-found: activation is `PATCH /admin/registry/doctors/:id/active`; no admin-triggered reset exists |
| `POST /admin/clinics` (admin creates a clinic account), clinic-side cancel of a patient booking | Documented-but-not-found |
| `POST /doctor/blood-requests` (doctor-referred blood request; model column `referred_by_doctor_id` exists) | Planned ("a future ... can call `bloodRequest.service.create()`") |
| `GET /doctor/bookings/:id/documents`, record-reader backend items | Planned / client-side |
| `POST /ambulance/bookings/:id/location` (vehicle location updates) | Documented-but-not-found (module says no live tracking) |
| Realtime vehicle tracking, SMS/WhatsApp for ambulance events | Not implemented |

## Part B. Discrepancies with earlier documentation

| # | Earlier document | What it says | Current verified behaviour |
|---|---|---|---|
| 1 | `docs-shared/feature-plans/auth/README.md`, `backend-auth-plan.md` | "Plan / design (no code written yet - backend `src/` is empty)" | Fully implemented, and much broader: nine roles, per-portal logins, mobile-number login, password reset by e-mail link **and** OTP (SMS/e-mail), refresh rotation with reuse grace window |
| 2 | `backend/docs/README.md` (the old `backend/README.md`) | Lists auth endpoints `register, login, google, admin/login, refresh, forgot-password, reset-password` and `me, profile, change-password, logout`; folder tree without `db/ensure*`, `realtime/`, `templates/prescriptions` | Additional public endpoints exist: `/auth/clinic/login|google`, `/auth/medicine/login|google`, `/auth/blood-bank/register|login`, `/auth/ambulance/register|login`, `/auth/forgot-password/otp` and `/otp/verify` |
| 3 | `docs-shared/legacy/indiahealthsystem.md` (PRD) | Video via Google Meet / Cal.com; `meet_link` | LiveKit rooms; `bookings.meet_link` now stores the in-app call URL (`<patient origin>/dashboard/appointments/<id>/call`); `meet_event_id` column is vestigial |
| 4 | `booking-payments/*`, `clinics-availability/*`, `clinic-account/*` | Slot-based booking, `GET /doctors/:id/slots` | Replaced by consultation sessions and tokens (`GET /doctors/:id/sessions`, `POST /patient/bookings` with a *date*, no time); no `/slots` endpoint exists. Booking rows still carry `slot_start_time` / `slot_end_time` = the session window |
| 5 | `consultation-queue/*` | "Planned - nothing in this document is built yet" | Implemented: migration 027, `session.service`, `/doctor/sessions/*`, `/doctor/bookings/:id/start-consult|skip`, `/patient/bookings/:id/queue` |
| 6 | `follow-up-status/*`, `follow-up-reminders-07-09-2026/*` | "Planned - nothing built" | Implemented: migrations 025/026/029, `followUp.service`, `followUpReminder.service`, the scheduler, WhatsApp opt-in (real WhatsApp needs the missing `twilio` package) |
| 7 | `treatment-timeline/*` | "Planned - not started" | Implemented: `treatmentTimeline.service`, `/doctor/patients*`, `/doctor/bookings/:id/patient-timeline`, `/patient/timeline`, plus `patientTimeline.service` for the workbench |
| 8 | `vitals-reference-ranges/*`, `vitals-record-table/*` | "Planned", `GET /vitals/ranges` | `config/vitalsRanges.js` is applied in serializers (adult bands, refuses under 18); `patient_vitals.location` migration 012 exists; no ranges endpoint |
| 9 | `clinic-account/README.md` | "Planned - not started" | Implemented (see its own `as-built.md`): clinic role, profile, documents, approval gate, patient workspace |
| 10 | `doctor-onboarding/README.md`, `doctor-portfolio-v2/README.md` | tables "not yet migrated or modelled" | Migrated (002, 004, 046-049) and modelled; ten portfolio sections plus hero/showcase images |
| 11 | `admin-portal/*` | plan incl. doctor status and reset-password endpoints | Admin surface is larger (registry, deletion, ICD, clinics, blood banks, ambulances) but those two endpoints do not exist |
| 12 | `ambulance/README.md`, `ambulance/ARCHITECTURE.md` | "The project has no WebSocket/SSE infrastructure" | Socket.IO now exists (added 2026-10-25) for in-app notifications; ambulance still has no live GPS and clients poll every 20 s |
| 13 | `dbstruct.md` | 41 tables, `users.role` of four values | 112 models; role enum has ten values; five base tables have no model; counters tables (`rx_counters`, `blood_counters`) have no model |
| 14 | `video-consultation/README.md` | `video_sessions` created via `VideoSession.sync()` on dev | Migration `012_video_sessions.sql` is in the repo and applied by the runner |
| 15 | `ci/jenkins-setup.md`, `Jenkinsfile` | Jenkins deploys five apps to `/var/www/ihs` | Superseded by GitHub Actions + `scripts/deploy.sh` (paths under `/home/ubuntu/...`); the Jenkinsfile and `ecosystem.config.js` still define `ihs-clinic`, but the production list in `deploy.sh` has no clinic app; no pipeline or pm2 entry exists for the mr, blood-bank or ambulance portals |
| 16 | `CLOUDINARY_SETUP.md` | Describes the signed-link model for all drivers | Accurate for `local` and `cloudinary`; **S3 is not covered by signed links** |
| 17 | `.env.example` | Presented as the template for all variables | Lacks 21 variables read by `config/env.js`: `ACCESS_REQUEST_RATE_LIMIT_MAX, API_DOCS_ENABLED, CONTACT_RATE_LIMIT_MAX, DOCTOR_APP_URL, FORGOT_PASSWORD_RATE_LIMIT_MAX, ICD_SEARCH_SYSTEM, ICD_SEARCH_VERSION, PATIENT_SEARCH_RATE_LIMIT_MAX, PDF_ENGINE, PDF_MAX_CONCURRENCY, PDF_RATE_LIMIT_MAX, PDF_TIMEOUT_MS, PUPPETEER_EXECUTABLE_PATH, REMINDER_SCHEDULER_ENABLED, RX_NUMBER_PREFIX, SIGNUP_RATE_LIMIT_MAX, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_CONTENT_TEMPLATE_SID, TWILIO_WHATSAPP_FROM, WHATSAPP_PROVIDER` |
| 18 | `test/testEnv.js` message | refers to `backend/.env.test.example` | That file is not in the working tree (shown deleted by git) although `backend/.gitignore` whitelists it |
| 19 | Seeder comments (`lookups`, `subSpecializations`) | "Called from server.js on boot in development" | `server.js` calls all three seeders on every boot, in every environment |
| 20 | `backend/docs/feature-history/logger.md` | Named "logger" | It is a dated development session log, not a description of application logging |
| 21 | `docs-shared/legacy/IMPLEMENTATION-STATUS.md` | A point-in-time recovery note (2026-10-15/25): blockers, migrations 044/045, test results | Migrations now run to 060 (ICD master 059, import batches 060); the quoted test results were not re-run for this documentation |
| 22 | `docs-shared/legacy/PRODUCTION-READINESS-AUDIT.md` | backend hardening list partly "in progress" | Several of those items (reset/OTP limits, signup limits, docs gating in production, placeholder-secret refusal, no Ethereal in production, template escaping) are present in the current code |
| 23 | `medicine-store-platform-22-09-2026/README.md`, `mr-frontend-design-standardization-21-09-2026/`, `medicine-*-fix-22-09-2026/` | Written when the Medicine Representative (`mr`) was the provider type ("MR frontend", "MR login") | Since migration 036 MR is legacy: it cannot register (`SELF_REGISTERABLE_ROLES`), is excluded from patient-facing surfaces and new business, and existing MR accounts keep access to their own data; the active provider roles are `medicine_store` and `pharmacy_hospital` |

## Part C. Items that could not be verified

* Whether the live server's pm2 processes were started with `IHS_DEPLOY_ROOT` pointing at the `deploy.sh` checkout paths (deployment doc, section 4).
* Whether the live nginx allows WebSocket upgrade on `/socket.io`.
* Whether migration 052's e-mail OTP columns are covered by `ensurePasswordResetOtps` on pre-existing databases.
* Whether every raw SQL query in `services/` is parameterised (only a sample was reviewed).
* Client-side status of the "record reader".
* Whether Swagger covers every route.
* Whether the WhatsApp `email_status` quirk for WhatsApp-only reminders is visible to any client.
