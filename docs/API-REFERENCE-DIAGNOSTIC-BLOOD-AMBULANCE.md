# API Reference - Diagnostic labs, Blood bank, Ambulance

Conventions that apply to every table below:

* Paths are shown with the mount prefix already applied (`/api` = `API_PREFIX`). Auth column: the role(s) admitted by `authenticate` + `authorize(...)`; "Public" = no `authenticate`. Rate limiting: every route also passes the global limiter (reads by a signed-in user: `READ_RATE_LIMIT_MAX` per user; writes and anonymous traffic: `RATE_LIMIT_MAX`); route-specific limiters are named in the "Validation / middleware" column.
* "body: X" / "query: X" / "params: X" name the Joi schema applied (`validate`, `validateQuery` -> `req.validatedQuery`). Unknown keys are stripped, values coerced; failures are `422 VALIDATION_ERROR` with `details` per field.
* Success envelope `{ success, message, data }`; errors `{ error: { message, code, details? } }`. Binary/stream routes (PDF, files) return the bytes directly.
* The tables were generated from the router source by a static scan (route registration order preserved within each file). Route-ordering caveat: where a literal path (e.g. `/order`, `/count`) shares a prefix with a `/:id` route the literal one is declared first in the source.

Notes:

* **Diagnostics**: patients share a prescription (multipart `prescription`) with a lab chosen by location; the lab responds with per-test availability and prices; the patient books tests and a preferred date; the lab confirms and marks completion; reports (multipart `report`) are filed into the patient's `uploaded_records` with source `diagnostic_lab`. Prescription and report files stream only to the owning patient or lab (`participant` guard).
* **Blood bank** (`/blood-bank/*`): `profile` and `reference` need only a signed-in blood bank (so a pending centre can finish its details); every other route needs `requireApprovedBloodBank`. All queries are scoped by `req.bloodBankId`. Patients use `/blood/*` (search nearby banks, requests with an optional supporting document, camps, history).
* **Ambulance**: `/ambulances/reference`, `/nearby`, `/:id`, `/:id/estimate` are public; bookings require a patient. Provider operations need `requireApprovedAmbulanceProvider`; status moves are checked against `AMBULANCE_PROVIDER_TRANSITIONS`. Route-order caveat: `/ambulances/:id` is declared after `/bookings`.


### `routes/ambulance.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/ambulances/reference` | Public | - | `c.reference` |
| GET | `/api/ambulances/nearby` | Public | query: v.nearby | `c.nearby` |
| POST | `/api/ambulances/bookings` | patient | body: v.createBooking | `c.createBooking` |
| GET | `/api/ambulances/bookings` | patient | query: v.listBookings | `c.listBookings` |
| GET | `/api/ambulances/bookings/:id` | patient | - | `c.getBooking` |
| POST | `/api/ambulances/bookings/:id/cancel` | patient | body: v.patientCancel | `c.cancelBooking` |
| GET | `/api/ambulances/:id` | Public | query: v.publicDetails | `c.getAmbulance` |
| GET | `/api/ambulances/:id/estimate` | Public | query: v.estimate | `c.estimate` |

### `routes/ambulanceProvider.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/ambulance/profile` | ambulance_provider | - | `c.getProfile` |
| PUT | `/api/ambulance/profile` | ambulance_provider | body: v.updateProfile | `c.updateProfile` |
| POST | `/api/ambulance/profile/resubmit` | ambulance_provider | - | `c.resubmit` |
| GET | `/api/ambulance/reference` | ambulance_provider | - | `c.reference` |
| GET | `/api/ambulance/dashboard` | ambulance_provider (approved + active) | - | `c.dashboard` |
| GET | `/api/ambulance/ambulances` | ambulance_provider (approved + active) | query: v.listAmbulances | `c.listAmbulances` |
| POST | `/api/ambulance/ambulances` | ambulance_provider (approved + active) | body: v.createAmbulance | `c.createAmbulance` |
| GET | `/api/ambulance/ambulances/:id` | ambulance_provider (approved + active) | - | `c.getAmbulance` |
| PUT | `/api/ambulance/ambulances/:id` | ambulance_provider (approved + active) | body: v.updateAmbulance | `c.updateAmbulance` |
| PUT | `/api/ambulance/ambulances/:id/availability` | ambulance_provider (approved + active) | body: v.setAvailability | `c.setAvailability` |
| PUT | `/api/ambulance/ambulances/:id/driver` | ambulance_provider (approved + active) | body: v.setDefaultDriver | `c.setDefaultDriver` |
| GET | `/api/ambulance/drivers` | ambulance_provider (approved + active) | query: v.listDrivers | `c.listDrivers` |
| POST | `/api/ambulance/drivers` | ambulance_provider (approved + active) | body: v.createDriver | `c.createDriver` |
| GET | `/api/ambulance/drivers/:id` | ambulance_provider (approved + active) | - | `c.getDriver` |
| PUT | `/api/ambulance/drivers/:id` | ambulance_provider (approved + active) | body: v.updateDriver | `c.updateDriver` |
| GET | `/api/ambulance/bookings` | ambulance_provider (approved + active) | query: v.listBookings | `c.listBookings` |
| GET | `/api/ambulance/bookings/:id` | ambulance_provider (approved + active) | - | `c.getBooking` |
| POST | `/api/ambulance/bookings/:id/accept` | ambulance_provider (approved + active) | body: v.acceptBooking | `c.accept` |
| POST | `/api/ambulance/bookings/:id/reject` | ambulance_provider (approved + active) | body: v.rejectBooking | `c.reject` |
| POST | `/api/ambulance/bookings/:id/assign-driver` | ambulance_provider (approved + active) | body: v.assignDriver | `c.assignDriver` |
| POST | `/api/ambulance/bookings/:id/status` | ambulance_provider (approved + active) | body: v.progressBooking | `c.progress` |
| POST | `/api/ambulance/bookings/:id/complete` | ambulance_provider (approved + active) | body: v.completeBooking | `c.complete` |
| POST | `/api/ambulance/bookings/:id/cancel` | ambulance_provider (approved + active) | body: v.providerCancel | `c.cancel` |

### `routes/blood.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/blood/reference` | patient | - | `c.reference` |
| GET | `/api/blood/nearby` | patient | query: v.nearby | `c.nearby` |
| GET | `/api/blood/banks/:id` | patient | - | `c.getBank` |
| POST | `/api/blood/requests` | patient | body: v.createRequest; multipart file `document` | `c.createRequest` |
| GET | `/api/blood/requests` | patient | query: v.listMyRequests | `c.listRequests` |
| GET | `/api/blood/requests/:id` | patient | - | `c.getRequest` |
| GET | `/api/blood/requests/:id/document` | patient | - | `c.requestDocument` |
| POST | `/api/blood/requests/:id/cancel` | patient | body: v.cancelRequest | `c.cancelRequest` |
| GET | `/api/blood/history` | patient | - | `c.history` |
| GET | `/api/blood/camps` | patient | query: v.publicCamps | `c.listCamps` |
| GET | `/api/blood/camps/mine` | patient | - | `c.myCamps` |
| POST | `/api/blood/camps/:id/register` | patient | body: v.campRegister | `c.registerCamp` |
| POST | `/api/blood/camps/:id/cancel` | patient | - | `c.cancelCamp` |

### `routes/bloodBank.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/blood-bank/profile` | blood_bank | - | `c.getProfile` |
| PUT | `/api/blood-bank/profile` | blood_bank | body: v.updateProfile | `c.updateProfile` |
| GET | `/api/blood-bank/reference` | blood_bank | - | `c.reference` |
| GET | `/api/blood-bank/dashboard` | blood_bank (approved + active) | - | `c.dashboard` |
| GET | `/api/blood-bank/audit` | blood_bank (approved + active) | query: v.listAudit | `c.audit` |
| GET | `/api/blood-bank/donors` | blood_bank (approved + active) | query: v.listDonors | `c.listDonors` |
| POST | `/api/blood-bank/donors` | blood_bank (approved + active) | body: v.createDonor | `c.createDonor` |
| GET | `/api/blood-bank/donors/:id` | blood_bank (approved + active) | - | `c.getDonor` |
| PUT | `/api/blood-bank/donors/:id` | blood_bank (approved + active) | body: v.updateDonor | `c.updateDonor` |
| POST | `/api/blood-bank/donors/:id/screenings` | blood_bank (approved + active) | body: v.screening | `c.addScreening` |
| GET | `/api/blood-bank/donations` | blood_bank (approved + active) | query: v.listDonations | `c.listDonations` |
| POST | `/api/blood-bank/donations` | blood_bank (approved + active) | body: v.createDonation | `c.createDonation` |
| GET | `/api/blood-bank/donations/:id` | blood_bank (approved + active) | - | `c.getDonation` |
| POST | `/api/blood-bank/donations/:id/tests` | blood_bank (approved + active) | body: v.addTest | `c.addTest` |
| PUT | `/api/blood-bank/donations/:id/testing` | blood_bank (approved + active) | body: v.testingDecision | `c.decideTesting` |
| GET | `/api/blood-bank/inventory` | blood_bank (approved + active) | query: v.inventorySummary | `c.inventorySummary` |
| GET | `/api/blood-bank/units` | blood_bank (approved + active) | query: v.listUnits | `c.listUnits` |
| GET | `/api/blood-bank/units/:id` | blood_bank (approved + active) | - | `c.getUnit` |
| PUT | `/api/blood-bank/units/:id` | blood_bank (approved + active) | body: v.updateUnit | `c.updateUnit` |
| POST | `/api/blood-bank/units/:id/release` | blood_bank (approved + active) | body: v.releaseUnit | `c.releaseUnit` |
| POST | `/api/blood-bank/units/:id/discard` | blood_bank (approved + active) | body: v.discardUnit | `c.discardUnit` |
| POST | `/api/blood-bank/units/:id/separate` | blood_bank (approved + active) | body: v.separate | `c.separateUnit` |
| GET | `/api/blood-bank/requests` | blood_bank (approved + active) | query: v.listBankRequests | `c.listRequests` |
| GET | `/api/blood-bank/requests/:id` | blood_bank (approved + active) | - | `c.getRequest` |
| GET | `/api/blood-bank/requests/:id/document` | blood_bank (approved + active) | - | `c.requestDocument` |
| PUT | `/api/blood-bank/requests/:id/status` | blood_bank (approved + active) | body: v.requestStatus | `c.setRequestStatus` |
| POST | `/api/blood-bank/requests/:id/reservations` | blood_bank (approved + active) | body: v.reserve | `c.reserve` |
| POST | `/api/blood-bank/requests/:id/crossmatches` | blood_bank (approved + active) | body: v.crossmatch | `c.crossmatch` |
| POST | `/api/blood-bank/requests/:id/approve` | blood_bank (approved + active) | body: v.approve | `c.approve` |
| POST | `/api/blood-bank/requests/:id/issues` | blood_bank (approved + active) | body: v.issue | `c.issue` |
| GET | `/api/blood-bank/reservations` | blood_bank (approved + active) | query: v.listReservations | `c.listReservations` |
| POST | `/api/blood-bank/reservations/:id/release` | blood_bank (approved + active) | body: v.releaseReservation | `c.releaseReservation` |
| GET | `/api/blood-bank/crossmatches` | blood_bank (approved + active) | query: v.listCrossmatches | `c.listCrossmatches` |
| GET | `/api/blood-bank/issues` | blood_bank (approved + active) | query: v.listIssues | `c.listIssues` |
| GET | `/api/blood-bank/camps` | blood_bank (approved + active) | query: v.listCamps | `c.listCamps` |
| POST | `/api/blood-bank/camps` | blood_bank (approved + active) | body: v.createCamp | `c.createCamp` |
| GET | `/api/blood-bank/camps/:id` | blood_bank (approved + active) | - | `c.getCamp` |
| PUT | `/api/blood-bank/camps/:id` | blood_bank (approved + active) | body: v.updateCamp | `c.updateCamp` |
| PUT | `/api/blood-bank/camps/:id/registrations/:registrationId` | blood_bank (approved + active) | body: v.campRegistrationStatus | `c.setCampRegistration` |

### `routes/diagnostic.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/diagnostics/labs` | patient | query: schema.listLabs | `controller.listLabs` |
| POST | `/api/diagnostics/requests` | patient | body: schema.shareRequest; multipart file `prescription` | `controller.shareRequest` |
| GET | `/api/diagnostics/requests/mine` | patient | query: schema.listRequests | `controller.listMyRequests` |
| POST | `/api/diagnostics/requests/:id/book` | patient | body: schema.book | `controller.book` |
| GET | `/api/diagnostics/requests/incoming` | diagnostic_lab | query: schema.listRequests | `controller.listLabRequests` |
| GET | `/api/diagnostics/summary` | diagnostic_lab | - | `controller.labSummary` |
| PUT | `/api/diagnostics/requests/:id/status` | diagnostic_lab | body: schema.updateStatus | `controller.updateStatus` |
| PUT | `/api/diagnostics/requests/:id/response` | diagnostic_lab | body: schema.respond | `controller.respond` |
| POST | `/api/diagnostics/requests/:id/reports` | diagnostic_lab | body: schema.uploadReport; multipart file `report` | `controller.uploadReport` |
| GET | `/api/diagnostics/tests` | diagnostic_lab | query: schema.listTests | `controller.listTests` |
| POST | `/api/diagnostics/tests` | diagnostic_lab | body: schema.createTest | `controller.createTest` |
| PUT | `/api/diagnostics/tests/:id` | diagnostic_lab | body: schema.updateTest | `controller.updateTest` |
| DELETE | `/api/diagnostics/tests/:id` | diagnostic_lab | - | `controller.removeTest` |
| GET | `/api/diagnostics/requests/:id/file` | patient or diagnostic_lab | - | `controller.streamFile` |
| GET | `/api/diagnostics/requests/:id/tests/:testId/report` | patient or diagnostic_lab | - | `controller.streamReport` |
| GET | `/api/diagnostics/requests/:id` | patient or diagnostic_lab | - | `controller.getRequest` |

