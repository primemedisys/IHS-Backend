# API Reference - Admin (`/api/admin/*`)

Conventions that apply to every table below:

* Paths are shown with the mount prefix already applied (`/api` = `API_PREFIX`). Auth column: the role(s) admitted by `authenticate` + `authorize(...)`; "Public" = no `authenticate`. Rate limiting: every route also passes the global limiter (reads by a signed-in user: `READ_RATE_LIMIT_MAX` per user; writes and anonymous traffic: `RATE_LIMIT_MAX`); route-specific limiters are named in the "Validation / middleware" column.
* "body: X" / "query: X" / "params: X" name the Joi schema applied (`validate`, `validateQuery` -> `req.validatedQuery`). Unknown keys are stripped, values coerced; failures are `422 VALIDATION_ERROR` with `details` per field.
* Success envelope `{ success, message, data }`; errors `{ error: { message, code, details? } }`. Binary/stream routes (PDF, files) return the bytes directly.
* The tables were generated from the router source by a static scan (route registration order preserved within each file). Route-ordering caveat: where a literal path (e.g. `/order`, `/count`) shares a prefix with a `/:id` route the literal one is declared first in the source.

All routes require `authenticate` + `authorize("admin")`. Routes under `/admin/doctors/:doctorId/*` additionally run `resolveDoctorId("param")` (404 if the doctor does not exist) and reuse the doctor controllers, so an admin sees and edits exactly what the doctor does.

Notes:

* Verification queues: doctors, clinics, blood banks, ambulance providers (`verify` verdict + `active` / `listing` switches); ambulances are verified individually.
* `DELETE /admin/registry/patients/:id` and `/registry/doctors/:id` have `deletion-preview` counterparts (`GET .../deletion-preview`); a patient delete dismantles the whole record trail in one transaction; a doctor delete is refused with 409 when ANY dependent record exists (deactivate instead). Both are irreversible.
* ICD master: manual create/update, JSON chunk import (`POST /icd-codes/import`, <= 500 rows per request), Excel template/preview/commit (preview re-checked at commit: `ICD_IMPORT_STALE` if the file differs), import history, and a read of doctors' coded entries.
* `/admin/medicine/*`, `/admin/diagnostics/*` are **read-only** aggregates (admin sees workflow and counts, never prescription files, report files or test names).


### `routes/adminAllClinics.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/all-clinics` | admin | - | `allClinics.listAll` |

### `routes/adminAmbulance.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/ambulances/summary` | admin | - | `c.summary` |
| GET | `/api/admin/ambulance-providers` | admin | query: v.adminListProviders | `c.listProviders` |
| GET | `/api/admin/ambulance-providers/:id` | admin | - | `c.getProvider` |
| POST | `/api/admin/ambulance-providers/:id/verify` | admin | body: v.adminVerifyProvider | `c.verifyProvider` |
| PATCH | `/api/admin/ambulance-providers/:id/active` | admin | body: v.adminSetActive | `c.setProviderActive` |
| GET | `/api/admin/ambulance-bookings` | admin | query: v.adminListBookings | `c.listBookings` |
| GET | `/api/admin/ambulance-bookings/:id` | admin | - | `c.getBooking` |
| GET | `/api/admin/ambulances` | admin | query: v.adminListAmbulances | `c.listAmbulances` |
| GET | `/api/admin/ambulances/:id` | admin | - | `c.getAmbulance` |
| POST | `/api/admin/ambulances/:id/verify` | admin | body: v.adminVerifyAmbulance | `c.verifyAmbulance` |
| PATCH | `/api/admin/ambulances/:id/active` | admin | body: v.adminSetActive | `c.setAmbulanceActive` |

### `routes/adminBloodBank.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/blood-banks/summary` | admin | - | `c.summary` |
| GET | `/api/admin/blood-banks/inventory` | admin | query: v.adminInventory | `c.inventory` |
| GET | `/api/admin/blood-banks/requests` | admin | query: v.adminListRequests | `c.requests` |
| GET | `/api/admin/blood-banks` | admin | query: v.adminListBanks | `c.listBanks` |
| GET | `/api/admin/blood-banks/:id` | admin | - | `c.getBank` |
| POST | `/api/admin/blood-banks/:id/verify` | admin | body: v.adminVerify | `c.verify` |
| PATCH | `/api/admin/blood-banks/:id/active` | admin | body: v.adminSetActive | `c.setActive` |

### `routes/adminClinic.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/clinics` | admin | - | `adminClinic.listForReview` |
| GET | `/api/admin/clinics/:id` | admin | - | `adminClinic.getForReview` |
| POST | `/api/admin/clinics/:id/verify` | admin | body: schema.verifyClinic | `adminClinic.verify` |
| PATCH | `/api/admin/clinics/:id/active` | admin | body: schema.setClinicActive | `adminClinic.setActive` |

### `routes/adminContact.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/contact-messages` | admin | query: schema.listMessages | `adminContact.list` |
| PATCH | `/api/admin/contact-messages/:id` | admin | body: schema.updateMessage | `adminContact.update` |

### `routes/adminDashboard.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/dashboard/summary` | admin | query: schema.summary | `dashboard.adminSummary` |
| GET | `/api/admin/dashboard/revenue-series` | admin | query: schema.series | `earnings.revenueSeries` |
| GET | `/api/admin/dashboard/top-doctors` | admin | query: schema.topDoctors | `earnings.topDoctors` |
| GET | `/api/admin/bookings` | admin | - | `dashboard.adminBookings` |

### `routes/adminDiagnostic.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/diagnostics/overview` | admin | - | `controller.overview` |
| GET | `/api/admin/diagnostics/requests` | admin | query: schema.adminListRequests | `controller.requests` |

### `routes/adminDoctor.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/doctors` | admin | - | `adminDoctor.listForReview` |
| GET | `/api/admin/doctors/:id` | admin | - | `adminDoctor.getForReview` |
| POST | `/api/admin/doctors/:id/verify` | admin | body: schema.verifyDoctor | `adminDoctor.verify` |
| PATCH | `/api/admin/doctors/:id/listing` | admin | body: schema.setListing | `adminDoctor.setListing` |

### `routes/adminDoctorManage.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/admin/doctors` | admin | body: adminSchema.createDoctor | `adminManage.create` |
| GET | `/api/admin/doctors/:doctorId/onboarding` | admin (+ target doctor must exist) | - | `doctor.onboarding` |
| GET | `/api/admin/doctors/:doctorId/profile` | admin (+ target doctor must exist) | - | `doctor.getProfile` |
| PATCH | `/api/admin/doctors/:doctorId/profile` | admin (+ target doctor must exist) | body: schema.updateProfile | `doctor.updateProfile` |
| GET | `/api/admin/doctors/:doctorId/preview` | admin (+ target doctor must exist) | - | `doctor.preview` |
| PUT | `/api/admin/doctors/:doctorId/specializations` | admin (+ target doctor must exist) | body: schema.setSpecializations | `doctor.setSpecializations` |
| PUT | `/api/admin/doctors/:doctorId/languages` | admin (+ target doctor must exist) | body: schema.setLanguages | `doctor.setLanguages` |
| DELETE | `/api/admin/doctors/:doctorId/awards/:id` | admin (+ target doctor must exist) | - | `doctor.removeAward` |
| DELETE | `/api/admin/doctors/:doctorId/links/:id` | admin (+ target doctor must exist) | - | `doctor.removeLink` |
| DELETE | `/api/admin/doctors/:doctorId/keywords/:id` | admin (+ target doctor must exist) | - | `doctor.removeKeyword` |
| GET | `/api/admin/doctors/:doctorId/documents` | admin (+ target doctor must exist) | - | `doctor.listDocuments` |
| POST | `/api/admin/doctors/:doctorId/documents` | admin (+ target doctor must exist) | body: schema.uploadDocument; multipart file `file` | `doctor.uploadDocument` |
| DELETE | `/api/admin/doctors/:doctorId/documents/:id` | admin (+ target doctor must exist) | - | `doctor.removeDocument` |
| POST | `/api/admin/doctors/:doctorId/photo` | admin (+ target doctor must exist) | multipart file `file` | `doctor.uploadPhoto` |
| DELETE | `/api/admin/doctors/:doctorId/gallery/:id` | admin (+ target doctor must exist) | - | `doctor.removeGallery` |
| PUT | `/api/admin/doctors/:doctorId/insurances` | admin (+ target doctor must exist) | body: schema.setInsurances | `doctor.setInsurances` |
| DELETE | `/api/admin/doctors/:doctorId/exceptions/:id` | admin (+ target doctor must exist) | - | `clinic.removeException` |
| GET | `/api/admin/doctors/:doctorId/awards` | admin (+ target doctor must exist) | - | `doctor.listAwards` |
| POST | `/api/admin/doctors/:doctorId/awards` | admin (+ target doctor must exist) | body: schema.createAward | `doctor.addAward` |
| GET | `/api/admin/doctors/:doctorId/links` | admin (+ target doctor must exist) | - | `doctor.listLinks` |
| POST | `/api/admin/doctors/:doctorId/links` | admin (+ target doctor must exist) | body: schema.createLink | `doctor.addLink` |
| GET | `/api/admin/doctors/:doctorId/keywords` | admin (+ target doctor must exist) | - | `doctor.listKeywords` |
| POST | `/api/admin/doctors/:doctorId/keywords` | admin (+ target doctor must exist) | body: schema.createKeyword | `doctor.addKeyword` |
| GET | `/api/admin/doctors/:doctorId/gallery` | admin (+ target doctor must exist) | - | `doctor.listGallery` |
| POST | `/api/admin/doctors/:doctorId/gallery` | admin (+ target doctor must exist) | body: schema.uploadGallery; multipart file `file` | `doctor.addGallery` |
| GET | `/api/admin/doctors/:doctorId/clinics` | admin (+ target doctor must exist) | - | `clinic.listClinics` |
| POST | `/api/admin/doctors/:doctorId/clinics` | admin (+ target doctor must exist) | body: clinicSchema.createClinic | `clinic.addClinic` |
| GET | `/api/admin/doctors/:doctorId/clinics/:id` | admin (+ target doctor must exist) | - | `clinic.getClinic` |
| PATCH | `/api/admin/doctors/:doctorId/clinics/:id` | admin (+ target doctor must exist) | body: clinicSchema.updateClinic | `clinic.updateClinic` |
| DELETE | `/api/admin/doctors/:doctorId/clinics/:id` | admin (+ target doctor must exist) | - | `clinic.removeClinic` |
| GET | `/api/admin/doctors/:doctorId/clinics/:id/availability` | admin (+ target doctor must exist) | - | `clinic.getClinicAvailability` |
| PUT | `/api/admin/doctors/:doctorId/clinics/:id/availability` | admin (+ target doctor must exist) | body: clinicSchema.setAvailability | `clinic.setClinicAvailability` |
| GET | `/api/admin/doctors/:doctorId/online-availability` | admin (+ target doctor must exist) | - | `clinic.getOnlineAvailability` |
| PUT | `/api/admin/doctors/:doctorId/online-availability` | admin (+ target doctor must exist) | body: clinicSchema.setAvailability | `clinic.setOnlineAvailability` |
| GET | `/api/admin/doctors/:doctorId/exceptions` | admin (+ target doctor must exist) | - | `clinic.listExceptions` |
| POST | `/api/admin/doctors/:doctorId/exceptions` | admin (+ target doctor must exist) | body: clinicSchema.createException | `clinic.addException` |

### `routes/adminIcd.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/icd-codes/meta` | admin | - | `controller.meta` |
| GET | `/api/admin/icd-codes` | admin | query: schema.listQuery | `controller.list` |
| POST | `/api/admin/icd-codes` | admin | body: schema.create | `controller.create` |
| POST | `/api/admin/icd-codes/import` | admin | body: schema.importBody | `controller.importRows` |
| GET | `/api/admin/icd-codes/import/template` | admin | - | `controller.excelTemplate` |
| POST | `/api/admin/icd-codes/import/preview` | admin | body: schema.excelPreview; multipart file `file` | `controller.excelPreview` |
| POST | `/api/admin/icd-codes/import/excel` | admin | body: schema.excelCommit; multipart file `file` | `controller.excelCommit` |
| GET | `/api/admin/icd-codes/imports` | admin | query: schema.historyQuery | `controller.importHistory` |
| GET | `/api/admin/icd-codes/doctor-entries` | admin | query: schema.doctorEntriesQuery | `controller.doctorEntries` |
| PATCH | `/api/admin/icd-codes/:id` | admin | params: schema.idParams; body: schema.update | `controller.update` |

### `routes/adminMedicine.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/medicine/overview` | admin | query: schema.overview | `controller.overview` |
| GET | `/api/admin/medicine/orders` | admin | query: schema.orders | `controller.orders` |
| GET | `/api/admin/medicine/inventory` | admin | query: schema.inventory | `controller.inventory` |
| GET | `/api/admin/medicine/pharmacies` | admin | query: schema.pharmacies | `controller.pharmacies` |

### `routes/adminRegistry.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/admin/registry/doctors` | admin | - | `registry.listDoctors` |
| GET | `/api/admin/registry/patients` | admin | - | `registry.listPatients` |
| GET | `/api/admin/registry/patients/:id` | admin | - | `registry.getPatient` |
| GET | `/api/admin/registry/patients/:id/deletion-preview` | admin | - | `registry.deletionPreview` |
| DELETE | `/api/admin/registry/patients/:id` | admin | - | `registry.deletePatient` |
| POST | `/api/admin/registry/patients/:id/records` | admin | body: patientSchema.uploadRecord; multipart file `file` | `registry.uploadPatientRecord` |
| GET | `/api/admin/registry/doctors/:id/deletion-preview` | admin | params: adminSchema.doctorIdParams | `registry.doctorDeletionPreview` |
| DELETE | `/api/admin/registry/doctors/:id` | admin | params: adminSchema.doctorIdParams; body: adminSchema.deleteDoctor | `registry.deleteDoctor` |
| PATCH | `/api/admin/registry/doctors/:id/active` | admin | params: adminSchema.doctorIdParams; body: adminSchema.setDoctorActive | `registry.setDoctorActive` |


### Loop-generated portfolio routes (`routes/adminDoctorManage.routes.js`)

Six sections (education, experience, services, publications, memberships, faqs) are generated per doctor; the admin router does **not** generate testimonials, affiliations, fellowships or expertise routes (verified in the source), so those are only reachable by the doctor:

| Method | Path | Auth / role | Validation | Handler |
|---|---|---|---|---|
| GET | `/api/admin/doctors/:doctorId/education` | admin (+ target doctor must exist) | - | `doctor.education.list` |
| POST | `/api/admin/doctors/:doctorId/education` | admin (+ target doctor must exist) | body: schema.createEducation | `doctor.education.add` |
| PATCH | `/api/admin/doctors/:doctorId/education/:id` | admin (+ target doctor must exist) | body: schema.createEducation made partial | `doctor.education.update` |
| DELETE | `/api/admin/doctors/:doctorId/education/:id` | admin (+ target doctor must exist) | - | `doctor.education.remove` |
| GET | `/api/admin/doctors/:doctorId/experience` | admin (+ target doctor must exist) | - | `doctor.experience.list` |
| POST | `/api/admin/doctors/:doctorId/experience` | admin (+ target doctor must exist) | body: schema.createExperience | `doctor.experience.add` |
| PATCH | `/api/admin/doctors/:doctorId/experience/:id` | admin (+ target doctor must exist) | body: schema.createExperience made partial | `doctor.experience.update` |
| DELETE | `/api/admin/doctors/:doctorId/experience/:id` | admin (+ target doctor must exist) | - | `doctor.experience.remove` |
| GET | `/api/admin/doctors/:doctorId/services` | admin (+ target doctor must exist) | - | `doctor.services.list` |
| POST | `/api/admin/doctors/:doctorId/services` | admin (+ target doctor must exist) | body: schema.createService | `doctor.services.add` |
| PATCH | `/api/admin/doctors/:doctorId/services/:id` | admin (+ target doctor must exist) | body: schema.createService made partial | `doctor.services.update` |
| DELETE | `/api/admin/doctors/:doctorId/services/:id` | admin (+ target doctor must exist) | - | `doctor.services.remove` |
| GET | `/api/admin/doctors/:doctorId/publications` | admin (+ target doctor must exist) | - | `doctor.publications.list` |
| POST | `/api/admin/doctors/:doctorId/publications` | admin (+ target doctor must exist) | body: schema.createPublication | `doctor.publications.add` |
| PATCH | `/api/admin/doctors/:doctorId/publications/:id` | admin (+ target doctor must exist) | body: schema.createPublication made partial | `doctor.publications.update` |
| DELETE | `/api/admin/doctors/:doctorId/publications/:id` | admin (+ target doctor must exist) | - | `doctor.publications.remove` |
| GET | `/api/admin/doctors/:doctorId/memberships` | admin (+ target doctor must exist) | - | `doctor.memberships.list` |
| POST | `/api/admin/doctors/:doctorId/memberships` | admin (+ target doctor must exist) | body: schema.createMembership | `doctor.memberships.add` |
| PATCH | `/api/admin/doctors/:doctorId/memberships/:id` | admin (+ target doctor must exist) | body: schema.createMembership made partial | `doctor.memberships.update` |
| DELETE | `/api/admin/doctors/:doctorId/memberships/:id` | admin (+ target doctor must exist) | - | `doctor.memberships.remove` |
| GET | `/api/admin/doctors/:doctorId/faqs` | admin (+ target doctor must exist) | - | `doctor.faqs.list` |
| POST | `/api/admin/doctors/:doctorId/faqs` | admin (+ target doctor must exist) | body: schema.createFaq | `doctor.faqs.add` |
| PATCH | `/api/admin/doctors/:doctorId/faqs/:id` | admin (+ target doctor must exist) | body: schema.createFaq made partial | `doctor.faqs.update` |
| DELETE | `/api/admin/doctors/:doctorId/faqs/:id` | admin (+ target doctor must exist) | - | `doctor.faqs.remove` |
