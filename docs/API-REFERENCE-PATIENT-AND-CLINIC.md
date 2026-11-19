# API Reference - Patient (`/api/patient/*`) and Clinic (`/api/clinic/*`)

Conventions that apply to every table below:

* Paths are shown with the mount prefix already applied (`/api` = `API_PREFIX`). Auth column: the role(s) admitted by `authenticate` + `authorize(...)`; "Public" = no `authenticate`. Rate limiting: every route also passes the global limiter (reads by a signed-in user: `READ_RATE_LIMIT_MAX` per user; writes and anonymous traffic: `RATE_LIMIT_MAX`); route-specific limiters are named in the "Validation / middleware" column.
* "body: X" / "query: X" / "params: X" name the Joi schema applied (`validate`, `validateQuery` -> `req.validatedQuery`). Unknown keys are stripped, values coerced; failures are `422 VALIDATION_ERROR` with `details` per field.
* Success envelope `{ success, message, data }`; errors `{ error: { message, code, details? } }`. Binary/stream routes (PDF, files) return the bytes directly.
* The tables were generated from the router source by a static scan (route registration order preserved within each file). Route-ordering caveat: where a literal path (e.g. `/order`, `/count`) shares a prefix with a `/:id` route the literal one is declared first in the source.

* Patient routes: `authenticate` + `authorize("patient")`. Ownership is always the signed-in patient id; no patient id is ever read from a body or path on `/patient/*`.
* **Booking gate**: `POST /patient/bookings` requires a complete profile (`phone, dateOfBirth, gender, city`) else `422 PROFILE_INCOMPLETE`.
* Bookings payment: `POST /patient/bookings/:id/pay/verify` (Razorpay signature), `GET .../payment-qr` + `POST .../payment-report` (UPI QR "I have paid"), `POST .../video-token` (LiveKit join token; 10 min before to 30 min after the session window).
* **Clinic routes**: `/clinic/onboarding|profile|submit|documents` need only a signed-in clinic; everything under `/clinic/patients*` and `/clinic/bookings/*` needs an approved + active clinic (`requireApprovedClinic`); `/clinic/patients/:patientId/*` additionally runs `resolveClinicPatient`.


### `routes/clinicPortal.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/clinic/onboarding` | clinic | - | `clinicPortal.getOnboarding` |
| POST | `/api/clinic/submit` | clinic | - | `clinicPortal.submit` |
| POST | `/api/clinic/documents` | clinic | body: schema.uploadClinicDocument; multipart file `file` | `clinicPortal.uploadDocument` |
| DELETE | `/api/clinic/documents/:documentId` | clinic | - | `clinicPortal.deleteDocument` |
| GET | `/api/clinic/patients` | clinic (approved + active) | query: schema.listPatients | `clinicPatient.listPatients` |
| GET | `/api/clinic/patients/:patientId` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getPatient` |
| GET | `/api/clinic/patients/:patientId/timeline` | clinic (approved + active); :patientId must be an active patient | query: timelineSchema.listTimeline | `clinicPatient.getTimeline` |
| POST | `/api/clinic/patients/:patientId/records/upload` | clinic (approved + active); :patientId must be an active patient | body: schema.uploadRecord; multipart file `file` | `clinicPatient.uploadRecord` |
| PATCH | `/api/clinic/patients/:patientId/profile` | clinic (approved + active); :patientId must be an active patient | body: schema.updatePatientProfile | `clinicPatient.updatePatientProfile` |
| GET | `/api/clinic/patients/:patientId/prescriptions/:id/pdf` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.prescriptionPdf` |
| POST | `/api/clinic/bookings/:bookingId/video-token` | clinic (approved + active) | - | `clinicPatient.videoToken` |
| GET | `/api/clinic/profile` | clinic | - | `clinicPortal.getProfile` |
| PUT | `/api/clinic/profile` | clinic | body: schema.updateClinicProfile | `clinicPortal.updateProfile` |
| GET | `/api/clinic/patients/:patientId/vitals` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getVitals` |
| POST | `/api/clinic/patients/:patientId/vitals` | clinic (approved + active); :patientId must be an active patient | body: schema.addVitalsEntry | `clinicPatient.addVitals` |
| GET | `/api/clinic/patients/:patientId/records` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getRecords` |
| POST | `/api/clinic/patients/:patientId/records` | clinic (approved + active); :patientId must be an active patient | body: schema.addRecord | `clinicPatient.addRecord` |
| GET | `/api/clinic/patients/:patientId/allergies` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getAllergies` |
| POST | `/api/clinic/patients/:patientId/allergies` | clinic (approved + active); :patientId must be an active patient | body: schema.addAllergies | `clinicPatient.addAllergies` |
| GET | `/api/clinic/patients/:patientId/conditions` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getConditions` |
| POST | `/api/clinic/patients/:patientId/conditions` | clinic (approved + active); :patientId must be an active patient | body: schema.addConditions | `clinicPatient.addConditions` |
| GET | `/api/clinic/patients/:patientId/clinical-notes` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.getClinicalNotes` |
| POST | `/api/clinic/patients/:patientId/clinical-notes` | clinic (approved + active); :patientId must be an active patient | body: schema.createNote | `clinicPatient.addClinicalNote` |
| GET | `/api/clinic/patients/:patientId/bookings` | clinic (approved + active); :patientId must be an active patient | - | `clinicPatient.listBookings` |
| POST | `/api/clinic/patients/:patientId/bookings` | clinic (approved + active); :patientId must be an active patient | body: schema.createBooking | `clinicPatient.createBooking` |

### `routes/patient.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| PATCH | `/api/patient/medications/:id` | patient | body: schema.updateMedication | `patient.updateMedication` |
| DELETE | `/api/patient/medications/:id` | patient | - | `patient.deleteMedication` |
| POST | `/api/patient/records/upload` | patient | body: schema.uploadRecord; multipart file `file` | `patient.uploadRecord` |
| POST | `/api/patient/photo` | patient | multipart file `file` | `patient.uploadPhoto` |
| PATCH | `/api/patient/records/:id` | patient | body: schema.updateRecord | `patient.updateRecord` |
| PUT | `/api/patient/records/:id/file` | patient | multipart file `file` | `patient.replaceRecordFile` |
| DELETE | `/api/patient/records/:id` | patient | - | `patient.deleteRecord` |
| GET | `/api/patient/bookings/:id` | patient | - | `booking.getOne` |
| GET | `/api/patient/bookings/:id/queue` | patient | - | `session.myQueue` |
| POST | `/api/patient/bookings/:id/pay/verify` | patient | body: bookingSchema.verifyPayment | `booking.verify` |
| POST | `/api/patient/bookings/:id/cancel` | patient | body: bookingSchema.cancelBooking | `booking.cancel` |
| GET | `/api/patient/bookings/:id/payment-qr` | patient | - | `booking.paymentQr` |
| POST | `/api/patient/bookings/:id/payment-report` | patient | body: paymentQrSchema.reportPayment | `booking.reportPayment` |
| GET | `/api/patient/bookings/:id/clinical-notes` | patient | - | `booking.clinicalNotes` |
| POST | `/api/patient/bookings/:id/video-token` | patient | - | `booking.videoToken` |
| GET | `/api/patient/prescriptions` | patient | - | `prescription.list` |
| GET | `/api/patient/prescriptions/:id/pdf` | patient | - | `prescription.pdf` |
| GET | `/api/patient/prescriptions/:id` | patient | - | `prescription.getOne` |
| GET | `/api/patient/journeys` | patient | - | `journey.list` |
| GET | `/api/patient/journeys/:id` | patient | - | `journey.getOne` |
| GET | `/api/patient/timeline` | patient | query: timelineSchema.listTimeline | `timeline.list` |
| GET | `/api/patient/follow-ups/upcoming` | patient | - | `patientFollowUp.listUpcoming` |
| PATCH | `/api/patient/profile/whatsapp-opt-in` | patient | body: followUpReminderSchema.toggleWhatsAppOptIn | `patientFollowUp.toggleWhatsAppOptIn` |
| GET | `/api/patient/profile` | patient | - | `patient.getProfile` |
| PUT | `/api/patient/profile` | patient | body: schema.updateProfile | `patient.updateProfile` |
| GET | `/api/patient/allergies` | patient | - | `patient.getAllergies` |
| PUT | `/api/patient/allergies` | patient | body: schema.setAllergies | `patient.setAllergies` |
| GET | `/api/patient/conditions` | patient | - | `patient.getConditions` |
| PUT | `/api/patient/conditions` | patient | body: schema.setConditions | `patient.setConditions` |
| GET | `/api/patient/medications` | patient | - | `patient.getMedications` |
| POST | `/api/patient/medications` | patient | body: schema.createMedication | `patient.addMedication` |
| PATCH | `/api/patient/medications` | patient | body: schema.setNoCurrentMedications | `patient.setNoCurrentMedications` |
| GET | `/api/patient/records` | patient | - | `patient.getRecords` |
| POST | `/api/patient/records` | patient | body: schema.addRecord | `patient.addRecord` |
| GET | `/api/patient/vitals` | patient | - | `patient.getVitals` |
| POST | `/api/patient/vitals` | patient | body: schema.addVitalsEntry | `patient.addVitals` |
| GET | `/api/patient/bookings` | patient | - | `booking.list` |
| POST | `/api/patient/bookings` | patient | body: bookingSchema.createBooking | `booking.create` |

### `routes/patientAcquisition.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/patient/acquisition/sources` | patient | - | `c.sources` |
| GET | `/api/patient/acquisition/doctors/:doctorId` | patient | params: doctorParams | `c.statusForDoctor` |

### `routes/patientDashboard.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/patient/dashboard/summary` | patient | - | `dashboard.patientSummary` |

### `routes/patientEmr.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/patient/medical-profile` | patient | - | `emr.myMedicalProfile` |
| GET | `/api/patient/medical-history` | patient | - | `emr.myMedicalHistory` |
| GET | `/api/patient/visits/:bookingId/summary` | patient | params: s.bookingParams | `emr.myVisitSummary` |

### `routes/patientMedicine.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/patient/medicines` | patient | query: s.listQuery | `c.list` |
| POST | `/api/patient/medicines` | patient | body: s.createMedicines | `c.create` |
| GET | `/api/patient/medicines/search` | patient | query: s.searchQuery | `c.search` |
| GET | `/api/patient/medicines/summary` | patient | - | `c.summary` |
| GET | `/api/patient/medicines/doses` | patient | query: s.dosesQuery | `c.doses` |
| GET | `/api/patient/medicines/doses/history` | patient | query: s.historyQuery | `c.history` |
| POST | `/api/patient/medicines/doses/:doseId/action` | patient | params: s.doseParams; body: s.doseAction | `c.doseAction` |
| GET | `/api/patient/medicines/settings` | patient | - | `c.getSettings` |
| PUT | `/api/patient/medicines/settings` | patient | body: s.updateSettings | `c.updateSettings` |
| GET | `/api/patient/medicines/:id` | patient | params: s.idParams | `c.getOne` |
| PATCH | `/api/patient/medicines/:id` | patient | params: s.idParams; body: s.updateMedicine | `c.update` |
| PUT | `/api/patient/medicines/:id/status` | patient | params: s.idParams; body: s.setStatus | `c.setStatus` |

### `routes/patientRecordAccess.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/patient/access-requests` | patient | query: schema.listQuery | `controller.listForPatient` |
| GET | `/api/patient/access-requests/:id` | patient | params: schema.idParam | `controller.getForPatient` |
| POST | `/api/patient/access-requests/:id/approve` | patient | params: schema.idParam; body: schema.approveAccessRequest | `controller.approve` |
| POST | `/api/patient/access-requests/:id/reject` | patient | params: schema.idParam; body: schema.rejectAccessRequest | `controller.reject` |
| POST | `/api/patient/access-requests/:id/revoke` | patient | params: schema.idParam | `controller.revoke` |

