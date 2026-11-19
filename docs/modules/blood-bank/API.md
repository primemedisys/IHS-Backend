# API

Base `/api`. Envelope: `{ success, message, data }`; errors `{ error: { message, code, details } }`.
Full request/response schemas: Swagger at `/api/docs` (tags **Blood Bank**, **Blood (patient)**, **Admin – Blood Banks**),
source `backend/src/config/swagger.bloodBank.js`. Every route below except the two auth routes requires a Bearer token.

## Auth

| Method | Path | Who |
|---|---|---|
| POST | `/auth/blood-bank/register` | public — creates a **pending** blood bank |
| POST | `/auth/blood-bank/login` | public — role `blood_bank` only (rate-limited) |
| — | `/auth/me`, `/auth/refresh`, `/auth/logout` | existing, shared |

## Blood bank portal — `/blood-bank` (role `blood_bank`)

Open to a pending bank: `GET /profile`, `PUT /profile`, `GET /reference`.
Everything else requires an **approved, active** bank (`requireApprovedBloodBank`, 403 `ONBOARDING_INCOMPLETE` otherwise).

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | cards + charts (expiry sweep first) |
| GET | `/audit` | own audit trail |
| GET, POST | `/donors` | list / register donor |
| GET, PUT | `/donors/:id` | detail (screenings, donations) / edit |
| POST | `/donors/:id/screenings` | record screening decision |
| GET, POST | `/donations` | list / record donation (+ whole-blood unit) |
| GET | `/donations/:id` | detail with tests + units |
| POST | `/donations/:id/tests` | record a lab result |
| PUT | `/donations/:id/testing` | record passed / failed decision |
| GET | `/inventory` | group × component grid |
| GET | `/units` | search units (filters, sort, paging) |
| GET, PUT | `/units/:id` | traceability / storage location |
| POST | `/units/:id/release` | release to AVAILABLE |
| POST | `/units/:id/discard` | discard |
| POST | `/units/:id/separate` | whole blood → components |
| GET | `/requests` | incoming (emergency first) |
| GET | `/requests/:id` | detail + reference compatibility + audit |
| GET | `/requests/:id/document` | stream supporting document |
| PUT | `/requests/:id/status` | viewed / processing / available / rejected |
| POST | `/requests/:id/reservations` | reserve a unit (locked) |
| POST | `/requests/:id/crossmatches` | record cross-match result |
| POST | `/requests/:id/approve` | authorised approval |
| POST | `/requests/:id/issues` | issue a unit |
| GET | `/reservations` · POST `/reservations/:id/release` | register / cancel reservation |
| GET | `/crossmatches`, `/issues` | registers |
| GET, POST | `/camps` · GET, PUT `/camps/:id` · PUT `/camps/:id/registrations/:registrationId` | camps |

Notifications use the **existing** `/medicine/notifications*` endpoints (role `blood_bank` added).

## Patient — `/blood` (role `patient`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/reference` | groups, components, statuses, reference compatibility |
| GET | `/nearby` | approved banks in city/state (+ distance with lat/lng) with availability for group + component |
| GET | `/banks/:id` | public profile + available stock |
| GET, POST | `/requests` | my requests / send request (multipart, optional `document`) |
| GET | `/requests/:id` | my request detail |
| GET | `/requests/:id/document` | stream my document |
| POST | `/requests/:id/cancel` | cancel (before reservation) |
| GET | `/history` | requests, camp registrations, linked donations |
| GET | `/camps` · GET `/camps/mine` | upcoming camps / my registrations |
| POST | `/camps/:id/register` · `/camps/:id/cancel` | register / cancel |

## Admin — `/admin/blood-banks` (role `admin`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/blood-banks/summary` | counts + trends |
| GET | `/admin/blood-banks` | verification queue |
| GET | `/admin/blood-banks/:id` | one bank |
| POST | `/admin/blood-banks/:id/verify` | approve / reject (notes required to reject) |
| PATCH | `/admin/blood-banks/:id/active` | suspend / reinstate |
| GET | `/admin/blood-banks/inventory` | per bank × group × component |
| GET | `/admin/blood-banks/requests` | request ledger (no documents) |

## Doctor — extension point (not exposed yet)

`blood_requests.referred_by_doctor_id` (FK users, nullable) + the existing `document_*` columns are in place.
A future `POST /doctor/blood-requests` can call `bloodRequest.service.create()` with `referredByDoctorId`;
no schema change is needed.

## Error codes

400 bad input / illegal transition · 401 unauthenticated / wrong password / wrong portal · 403 wrong role,
not owner, or bank not approved (`ONBOARDING_INCOMPLETE`, `details.verificationStatus`) · 404 not found or
not yours · 409 state conflict (already reserved/issued/used, duplicate registration, camp full) ·
422 validation (field `details`) or business rule (e.g. testing not passed, expired unit, missing compatible cross-match).
