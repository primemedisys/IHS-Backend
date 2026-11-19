# Testing Guide

Runner: the Node.js built-in test runner (`node --test`) with `node:assert`; no Jest/Mocha/Supertest. `npm test` = `node --test --test-concurrency=1 "test/**/*.test.js"` (suites are serialised because they share one database). 22 `*.test.js` files plus two helpers (`test/setupTestDb.js`, `test/testEnv.js`); roughly 340 test cases by a static count of top-level `test()` / `it()` calls.

Nothing in this guide was executed while writing the documentation (read-only task); descriptions come from the test sources and the earlier status note `docs-shared/legacy/IMPLEMENTATION-STATUS.md`.

## 1. Three kinds of suite

| Kind | How it runs | Needs |
|---|---|---|
| **DB-free** | pure functions / contract checks | Node only (some still `require("../testEnv")`, which demands a `.env.test` - see below) |
| **In-process E2E** | `require("../../src/app")` and calls it over real HTTP on an ephemeral port - no mocks: validation -> auth -> role gate -> approval gate -> service -> transaction -> DB | a LOCAL MySQL test database (`npm run test:db`) |
| **External E2E** | same scenarios against an already running API when `<SUITE>_E2E_BASE_URL` is set | a running API + its own DB; never point at production (suites create `@ihs-test.example.com` accounts and deactivate them afterwards) |

## 2. Test database (in-process suites)

`test/testEnv.js` must be required before anything from `src/`:

* loads `backend/.env.test` **first** (dotenv never overrides already-set variables, so its `DB_*` values win and `backend/.env` can only fill unrelated keys such as `JWT_ACCESS_SECRET`);
* forces `NODE_ENV=test`, `STORAGE_DRIVER=local`, `UPLOAD_DIR=test/.uploads`, `RATE_LIMIT_MAX=100000`, `AUTH_RATE_LIMIT_MAX=100000`, `SMTP_HOST=""`, and the admin test identity (`TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD`, defaults `admin@ihs-test.local` / a fixed test password);
* **refuses to run** unless `DB_HOST` is `localhost`, `127.0.0.1` or `::1` **and** `DB_NAME` ends with `_test` - a mis-copied file can never touch a shared or production database;
* exits with a message if `backend/.env.test` is missing. The message points to `backend/.env.test.example`, **which is not present in the current working tree** (it shows as deleted in git status; `backend/.gitignore` still whitelists it). Create `.env.test` by hand with local `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` (name ending `_test`) and `JWT_ACCESS_SECRET` (min 32 chars) plus the other required keys (`CLIENT_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`).

Build the database like production does:

```bash
cd backend
npm run test:db            # idempotent: migrate.js (base schema + migrations) + ensure* guards + admin seed
npm run test:db:fresh      # drops and recreates the *_test database first
npm test
```

`setupTestDb.js` runs `src/db/migrate.js`, then these guards: `ensureQueueColumns, ensurePrescriptionAvailability, ensureMedicineMaster, ensurePharmacyOrdering, ensureMedicineMedia, ensureDiagnosticLab, ensureBloodBank, ensureAmbulance, ensurePharmacyManagement, ensurePaymentQr`, then the admin seed. The MySQL user needs privileges on the test database; the earlier status note records that `ihs_app` lacked grants on `ihs_test` on one development machine and gives the `CREATE DATABASE` / `GRANT` statements an administrator must run (local only, never against shared/production databases).

## 3. External E2E recipe (documented in `backend/README.md`)

Start an API with test-sized limits, then point suites at it:

```bash
cd backend
PORT=5055 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000 \
AUTH_RATE_LIMIT_MAX=100000 SIGNUP_RATE_LIMIT_MAX=100000 \
FORGOT_PASSWORD_RATE_LIMIT_MAX=100000 PDF_RATE_LIMIT_MAX=1000 node src/server.js

RECORD_ACCESS_E2E_BASE_URL=http://localhost:5055 node --test test/recordAccess/recordAccess.test.js
```

Base-URL variables per suite: `PHARMACY_E2E_BASE_URL`, `DIAGNOSTIC_E2E_BASE_URL`, `PAYMENT_E2E_BASE_URL`, `RECORD_ACCESS_E2E_BASE_URL`, `DASHBOARD_E2E_BASE_URL`, `PORTFOLIO_E2E_BASE_URL`, `CONSENT_E2E_BASE_URL`, `MEDICINE_E2E_BASE_URL`, `MEDICAL_DOCS_E2E_BASE_URL`, `WORKBENCH_RX_E2E_BASE_URL`, `SECURITY_E2E_BASE_URL`. Pick a free port: the status note warns that another project on one development machine occupied port 5000, and a stale test API on the chosen port gives misleading results (Express 5 prints "listening" even when the port was taken - fixed in `server.js` by `processDiagnostics.watchServer`, which now reports the error and stops the process).

## 4. Suite catalogue

| Path | Kind | Cases | Covers |
|---|---|---|---|
| `ambulance/ambulance.unit.test.js` | DB-free | 17 | validators, fare/ETA model, geo helpers, the state-machine table, serializer audiences |
| `ambulance/ambulance.test.js` | in-process E2E | 14 | register (pending) -> hidden from search -> admin approves -> public search -> booking -> provider state machine -> cancellations |
| `blood/bloodBank.test.js` | in-process E2E | 20 | register -> approve -> donor -> screening -> donation -> tests -> release -> request -> reserve -> cross-match -> issue |
| `booking/mobileBooking.test.js` | in-process E2E | 7 | `PROFILE_INCOMPLETE` gate, video booking (dev payment bypass: no Razorpay keys in test), duplicate-booking guard |
| `clinicalCoding/clinicalCodingContract.test.js` | DB-free | 13 | ICD request contract, code normalisation/ranking, Workbench -> prescription snapshot, boot guard parses every ALTER from migration 059 |
| `clinicalConsent/clinicalConsent.test.js` | external E2E | 17 | clinical-history consent (migration 057) and structured medical history; doctor A/B/C + patients P/Q |
| `diagnostic/diagnostic.test.js` | in-process or external | 11 | catalogue -> share -> answer -> book -> transitions -> report; lab/pharmacy/patient isolation |
| `doctorDashboard/doctorDashboard.test.js` | in-process or external | 18 | acquisition answers on real bookings; hand-computed KPIs for a controlled practice; isolation |
| `doctorPortfolio/portfolioSections.test.js` | external | 13 | CRUD for the new portfolio sections, validation, ownership, public portfolio output |
| `emr/emrContract.test.js` | DB-free | 9 | EMR Joi contract, derived vitals (BMI, WHR, BP parse), visibility/edit rule, boot guard vs migration 051 |
| `emr/patientTimeline.test.js` | DB-free | 6 | timeline builder rules (one event per record, document date, sorting, filters, pagination) |
| `medicalDocuments/medicalDocuments.test.js` | in-process or external | 18 | document library on `uploaded_records`: categories, identity docs isolation, last-4 masking, ownership, replace/delete |
| `medicalDocuments/doctorDocuments.test.js` | external | 11 | patient documents as seen in the doctor's workbench with consent |
| `patientMedicine/medicineContract.test.js` | DB-free | 9 | schedule maths (time zones, windows), Joi contract, reminder privacy text, boot guard vs migration 055 |
| `patientMedicine/patientMedicine.test.js` | external (uses `socket.io-client`) | 27 | doctor My Medicines, prescription -> patient sync (draft never syncs, finalize once, amendment), patient routines, doses, Socket.IO |
| `payment/paymentQr.test.js` | in-process or external | 29 | provider UPI QR CRUD, payment-options, doctor bookings by UPI QR, report/confirm, pharmacy QR |
| `pharmacy/pharmacy.test.js` | in-process or external | 21 | catalogue/inventory, images, batches, Excel template/preview/import, suppliers, purchases, orders with GST, bill, returns, reports, isolation |
| `pharmacy/browseFilters.test.js` | in-process or external | 9 | `/medicine/browse` `providerId` + `minDiscount`, `/medicine/providers` lat/lng distance, defaults and 422 cases |
| `recordAccess/recordAccess.test.js` | in-process or external (Socket.IO) | 27 | dashboard split, notifications (REST + sockets), record-access lifecycle and audit |
| `security/globalLimiterAuthRoutes.test.js` | DB-free | 2 | auth routes keep answering when the global bucket is empty |
| `security/readWriteLimiter.test.js` | DB-free | 5 | separate per-user read budget vs write/anonymous backstop |
| `security/uploadHardening.test.js` | in-process or external | 4 | path-traversal delete safety, http(s)-only URLs, HTML/SVG disguised as image refused, non-passive files served as downloads |
| `storage/cloudinaryStorage.test.js` | DB-free (Cloudinary faked in memory) | 16 | key classification, URL parsing, signing, streaming, failure handling, signed link behaviour |
| `workbenchRx/workbenchRx.test.js` | external | 23 | Workbench -> prescription, shared medicine catalogue, admin ICD master, previous consultations |

Suite kinds were read from each file's header comment and its `EXTERNAL` switch; where a header only shows an external command the suite is marked external (it may also support in-process mode - **Unclear**). "in-process or external" means the file contains the `EXTERNAL = process.env.<X>_E2E_BASE_URL` switch and uses the in-process app when the variable is empty.

## 5. Quick commands

```bash
node --test test/ambulance/ambulance.unit.test.js      # DB-free
node --test test/clinicalCoding test/emr test/patientMedicine/medicineContract.test.js
node --test test/storage/cloudinaryStorage.test.js
node --test test/security/globalLimiterAuthRoutes.test.js test/security/readWriteLimiter.test.js
npm test                                              # everything, needs .env.test + local *_test DB
```

## 6. Gaps

* No unit tests for most services (booking transitions, prescription finalize, payment confirm are exercised only through the E2E suites); Razorpay and LiveKit calls are not mocked anywhere (the booking test relies on the dev bypass; webhook signature paths have no automated test found).
* No lint step, no coverage tooling (`coverage/` is merely git-ignored), no CI test stage - GitHub Actions and the superseded Jenkinsfile only deploy / syntax-check.
* The in-process suites depend on a database grant that was missing on at least one development machine (see section 2), so they may not run out of the box.
* Per the earlier status note, passing results quoted there (for example "21/21", "29/29", "27/27") were obtained against a separately started API on a local database at that time; they were **not re-run** for this documentation.
