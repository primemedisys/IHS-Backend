# Legacy Documentation Map (backend)

> **Historical note (documentation restructuring).** The pre-existing centralized `docs/` tree this map describes has been dissolved: every application now owns its documentation in `<app>/docs/`, and system-wide material lives in `docs-shared/`. Where a row still names an old `docs/<folder>` path, that centralized location no longer exists; in the shared map the "Legacy file" column already shows each document's new location. The authoritative old-to-new file mapping is `docs-shared/DOCUMENTATION-MIGRATION-REPORT.md`.

Maps every earlier document in the monorepo `docs/` folder that touches the backend to where its content now lives in this folder and what its status is against the current code. "Old docs" below are paths relative to the monorepo `docs/` folder (they are **not** links - the legacy folder is not part of this documentation set).

Review method: each legacy markdown file was opened (title, status line, headings) and every `METHOD /path` it mentions was cross-checked against the generated route tables; about 25 documents (auth, booking-payments, consultation-queue, video-consultation, prescriptions, clinic-account as-built, doctor-dashboard-2, medicine-management, pharmacy-management, diagnostic-lab, ambulance, blood-bank, CLOUDINARY_SETUP, IMPLEMENTATION-STATUS, PRODUCTION-READINESS-AUDIT, jenkins-setup, indiahealthsystem PRD, backend README, dbstruct) were read in more depth. The four `IHS-*-Mobile-App-Documentation.docx` files describe the mobile apps and were not used. Client-side `frontend-plan.md` files and the `frontend-*`, `mobile-*` and `shared` documentation folders belong to other documentation sets and are out of scope here.

Legend for "Status vs code": **Matches** (content consistent with code), **Superseded** (replaced by newer behaviour), **Stale status** (the document says planned/not built but the code exists), **Partly stale**, **Historical** (a dated log or fix note).

## 1. Root documents

| Old doc | Status vs code | Where the content now lives |
|---|---|---|
| `dbstruct.md` | Partly stale (41 tables; 112 models exist) - still the **base schema the migration runner reads** | Copied verbatim as [dbstruct.md](dbstruct.md); explained in [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md), [MIGRATIONS-AND-BOOT-GUARDS.md](MIGRATIONS-AND-BOOT-GUARDS.md) |
| `indiahealthsystem.md` (PRD) | Partly stale (Google Meet/Cal.com -> LiveKit; scope grew) | [APPLICATION-OVERVIEW.md](APPLICATION-OVERVIEW.md), [KNOWN-LIMITATIONS-AND-DISCREPANCIES.md](KNOWN-LIMITATIONS-AND-DISCREPANCIES.md) |
| `CLOUDINARY_SETUP.md` | Matches (except S3 note) | [FILE-STORAGE-AND-UPLOADS.md](FILE-STORAGE-AND-UPLOADS.md) |
| `IMPLEMENTATION-STATUS.md` | Historical (2026-10 recovery note, mostly mobile) | Backend facts folded into [TESTING-GUIDE.md](TESTING-GUIDE.md), [SECURITY.md](SECURITY.md), [KNOWN-LIMITATIONS-AND-DISCREPANCIES.md](KNOWN-LIMITATIONS-AND-DISCREPANCIES.md) |
| `PRODUCTION-READINESS-AUDIT.md` | Historical, partly done | [SECURITY.md](SECURITY.md) section 9 |
| `MOBILE_APPS.md` | Mobile - not backend | not mapped |
| `logger.md` | Historical session log (2026-09-22/24 medicine work) | not a logging guide; see [MIDDLEWARE-VALIDATION-AND-ERRORS.md](MIDDLEWARE-VALIDATION-AND-ERRORS.md) section 7 |
| `patient-record-page.md` | Client (doctor app) description | not mapped; related APIs in [API-REFERENCE-DOCTOR.md](API-REFERENCE-DOCTOR.md) |
| `ci/jenkins-setup.md` | Superseded banner in the file; server-bootstrap parts still valid | [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) |
| `backend/README.md` (old, inside `backend/`) | Partly stale (auth list, tree) | This folder's [README.md](README.md), [FOLDER-STRUCTURE.md](FOLDER-STRUCTURE.md), [AUTHENTICATION-AND-AUTHORIZATION.md](AUTHENTICATION-AND-AUTHORIZATION.md) |
| `backend/.env.example` | Partly stale (21 variables missing) | [ENVIRONMENT-CONFIGURATION.md](ENVIRONMENT-CONFIGURATION.md) |

## 2. Feature folders (README + backend-plan + integration-plan unless noted)

| Old folder | Status vs code | Where the content now lives |
|---|---|---|
| `auth/` (README, backend-auth-plan, frontend-auth-plan) | **Stale status** ("no code written yet"); design largely matches, implementation larger (OTP, mobile login, per-portal logins) | [AUTHENTICATION-AND-AUTHORIZATION.md](AUTHENTICATION-AND-AUTHORIZATION.md), [API-REFERENCE-AUTH-AND-PUBLIC.md](API-REFERENCE-AUTH-AND-PUBLIC.md) |
| `doctor-onboarding/` | Stale status (tables now migrated) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 2, [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 11, [API-REFERENCE-DOCTOR.md](API-REFERENCE-DOCTOR.md) |
| `doctor-portfolio-v2/` | Matches (implemented; v2 sections + migrations 046-049 extend it) | [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md), [API-REFERENCE-DOCTOR.md](API-REFERENCE-DOCTOR.md) |
| `doctor-listing-map-api/` | Matches (`/doctors`, `/doctors/map`) | [API-REFERENCE-AUTH-AND-PUBLIC.md](API-REFERENCE-AUTH-AND-PUBLIC.md), [API-REFERENCE.md](API-REFERENCE.md) |
| `clinics-availability/` | Partly stale: `GET /doctors/:id/slots` replaced by sessions | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 1 |
| `multi-clinic-booking/` | Matches (no backend change) | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) |
| `booking-payments/` | Partly stale (slot model replaced by token queue; Razorpay flow still accurate) | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 1, [INTEGRATIONS.md](INTEGRATIONS.md) section 1 |
| `consultation-queue/` | **Stale status** ("Planned") - implemented | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 1, [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 3 |
| `patient-booking-flow/` | Partly: doctor-approval workflow **Documented-but-not-found** | [KNOWN-LIMITATIONS-AND-DISCREPANCIES.md](KNOWN-LIMITATIONS-AND-DISCREPANCIES.md) A.4 |
| `video-consultation/` | Matches (LiveKit implemented) | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 2, [INTEGRATIONS.md](INTEGRATIONS.md) section 2 |
| `dashboards-earnings/` | Matches | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 3, [API-REFERENCE-DOCTOR.md](API-REFERENCE-DOCTOR.md), [API-REFERENCE-ADMIN.md](API-REFERENCE-ADMIN.md) |
| `doctor-dashboard-2-31-10-2026/` (README, api) | Matches (migration 056, `/doctor/analytics/*`) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 14, [API-REFERENCE-DOCTOR.md](API-REFERENCE-DOCTOR.md) |
| `clinical-notes/` (+ `vitals-and-prescription.md`) | Matches | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 5 |
| `patient-health-records/` | Matches | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 5, [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) |
| `vitals-record-table/` | Stale status ("awaiting implementation"; migration 012 exists) | [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md), [MIGRATIONS-AND-BOOT-GUARDS.md](MIGRATIONS-AND-BOOT-GUARDS.md) |
| `vitals-reference-ranges/` | Stale status; no `/vitals/ranges` endpoint | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 5, [KNOWN-LIMITATIONS-AND-DISCREPANCIES.md](KNOWN-LIMITATIONS-AND-DISCREPANCIES.md) |
| `treatment-timeline/` | **Stale status** - implemented | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 5 |
| `record-reader/` | Plan says no backend change - consistent | [APPLICATION-OVERVIEW.md](APPLICATION-OVERVIEW.md) section 4.4 |
| `follow-up-status/` | **Stale status** - implemented | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 5 |
| `follow-up-reminders-07-09-2026/` | **Stale status** - implemented (WhatsApp partly) | [BACKGROUND-JOBS-AND-REALTIME.md](BACKGROUND-JOBS-AND-REALTIME.md), [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 12 |
| `multi-doctor-referrals/` | Matches | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 3, [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 4 |
| `prescriptions/` | Matches (later extended by migrations 015, 053, 059) | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 4, [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 6 |
| `clinic-account/` (README, backend/frontend/integration plans, `as-built.md`) | Plans: stale status; `as-built.md` matches the code | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 12, [API-REFERENCE-PATIENT-AND-CLINIC.md](API-REFERENCE-PATIENT-AND-CLINIC.md) |
| `admin-portal/`, `admin-panel-enhancements/` | Partly stale (two planned endpoints absent; surface larger) | [API-REFERENCE-ADMIN.md](API-REFERENCE-ADMIN.md), [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 13 |
| `contact-and-booking-cta/` | Matches (migration 008, `/contact`, `/admin/contact-messages`) | [API-REFERENCE-AUTH-AND-PUBLIC.md](API-REFERENCE-AUTH-AND-PUBLIC.md) |
| `medicine-management-31-10-2026/` (README, api, mobile-notifications) | Matches (Socket.IO + local notifications, no Firebase) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 7, [BACKGROUND-JOBS-AND-REALTIME.md](BACKGROUND-JOBS-AND-REALTIME.md) |
| `pharmacy-management-09-10-2026/` | Matches (migration 043; explains the 041/042 gap) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 8, [MIGRATIONS-AND-BOOT-GUARDS.md](MIGRATIONS-AND-BOOT-GUARDS.md) section 6 |
| `medicine-store-platform-22-09-2026/` | Historical status report (MR-era wording) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 8 |
| `diagnostic-lab-26-09-2026/` | Matches | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 8 |
| `blood-bank/` (7 files) | Matches; `POST /doctor/blood-requests` is only "future" | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 9, [API-REFERENCE-DIAGNOSTIC-BLOOD-AMBULANCE.md](API-REFERENCE-DIAGNOSTIC-BLOOD-AMBULANCE.md) |
| `ambulance/` (8 files) | Partly stale ("no WebSocket infrastructure" - Socket.IO now exists; still no GPS) | [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) section 10 |

## 3. Dated fix notes (Historical)

| Old doc | What it recorded | Current code |
|---|---|---|
| `bugfix-18-07-2026/` | multi-tab refresh race mis-treated as token theft; refresh rate-limit bucket; treatment timeline; vitals ranges; reschedule; prescription attach fixes (migrations 015, 016) | Present: 30 s reuse grace + separate `refreshLimiter` ([AUTHENTICATION-AND-AUTHORIZATION.md](AUTHENTICATION-AND-AUTHORIZATION.md)) |
| `bugfix-31-07-2026/` | outbound MySQL timeout diagnosis (network, not code); report dates/edit; reports timeline | Operational note: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) section 1 |
| `bugfix-05-09-2026/` (+ sub-specialization doc) | registry 500 fix; doctor sub-specialization feature (migration 028) | [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 2 |
| `bugfix-08-09-2026/` | rejected-doctor deletion | `DELETE /admin/registry/doctors/:id` ([API-REFERENCE-ADMIN.md](API-REFERENCE-ADMIN.md)); current rule: refused when any trail exists |
| `bugfix-15-09-2026/` | blood-pressure split input + vitals de-duplication on the PDF | Rx/vitals columns in [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) |
| `admin-filter-updates-21-09-2026/`, `admin-frontend-cleanup-17-09-2026/` | admin list filters | [API-REFERENCE-ADMIN.md](API-REFERENCE-ADMIN.md) |
| `medicine-category-422-fix-`, `medicine-login-dashboard-fix-`, `prescription-request-schema-fix-` (all 2026-09-22), `mr-frontend-design-standardization-21-09-2026/` | provider category validation, auth redirect loop, prescription_requests schema mismatch, MR UI | Covered by [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md) section 8 and the validators; no extra behaviour to document |

## 4. Not mapped here (other documentation sets)

`frontend-*` (7 web portals), `mobile-*` (4 Expo apps), `shared/` and the monorepo `docs/README.md` were written by other documentation tasks. The four `IHS-*-Mobile-App-Documentation.docx` describe mobile apps.
