# Folder Structure

Counts below were taken from the working tree (`backend/src` = 517 files, of which 451 are `.js`).

```
backend/
├── package.json / package-lock.json      scripts, dependencies (CommonJS, "main": src/server.js)
├── nodemon.json                          watch ["src", ".env"], ext js,json,env, delay 300 ms
├── .env.example                          committed template (57 variables; see ENVIRONMENT-CONFIGURATION.md)
├── .gitignore                            ignores .env.*, /uploads/, /storage-migration/, /storage-cleanup.jsonl, coverage/
├── README.md                             short developer README (older; superseded by this folder)
├── scripts/
│   └── migrateUploadsToCloudinary.js     inventory / upload / apply / rollback / cleanup of local files -> Cloudinary
├── src/
│   ├── server.js                         process entry: DB connect -> guards -> seeds -> listen -> schedulers
│   ├── app.js                            Express app (no DB, no listen) - importable by tests
│   ├── config/            (18)           env.js, database.js, constants.js (1,449 lines), storage.js, cloudinary.js,
│   │                                     ambulance.js, bloodBank.js, pharmacy.js, vitalsRanges.js,
│   │                                     swagger.js + swagger.{ambulance,bloodBank,clinicalCoding,doctorAnalytics,
│   │                                     emr,patientMedicine,paymentQr,pharmacy,recordAccess}.js
│   ├── routes/            (44 + index)   one *.routes.js per surface; index.js mounts them under API_PREFIX
│   ├── controllers/       (58)           thin HTTP adapters (asyncHandler + apiResponse)
│   ├── services/          (88)           business logic and all DB access
│   ├── validators/        (33)           Joi schemas
│   ├── middlewares/       (12)           authenticate, authorize, validate, validateQuery, upload, rateLimiters,
│   │                                     errorHandler, resolveDoctorId, resolveClinicPatient,
│   │                                     requireApprovedClinic, requireApprovedBloodBank,
│   │                                     requireApprovedAmbulanceProvider
│   ├── models/            (112 + index)  Sequelize models; index.js wires every association once
│   ├── utils/             (28)           ApiError, apiResponse, asyncHandler, serializers (3,262 lines), tokens,
│   │                                     password, accessToken, fileUrlReplacer, fileSignature, sendFile, geo,
│   │                                     period, phone, slug, ids, age, rxNumber, bloodCode, documentNumber,
│   │                                     medicinePricing, medicineIdentity, medicineSchedule, ambulanceFare,
│   │                                     ambulanceSerializers, patientMedicineSerializers, patientRegNo, heroImages,
│   │                                     processDiagnostics
│   ├── db/
│   │   ├── migrate.js                    forward-only SQL runner (_migrations table)
│   │   ├── migrations/    (59 .sql)      001 ... 060 (041, 042 absent; 012 used twice)
│   │   └── ensure*.js     (48)           boot-time idempotent schema guards / dev parity shims
│   ├── realtime/
│   │   └── socket.js                     Socket.IO server + notification push hook
│   ├── seeders/           (3)            admin, lookups, subSpecializations
│   └── templates/
│       ├── emails/        (6 html)       contact-message, follow-up-reminder, password-reset-code,
│       │                                 prescription-ready, reset-password, verify-email
│       └── prescriptions/ (1 html)       rx.html (the PDF shell)
├── test/                  (26 files)     node:test suites + setupTestDb.js + testEnv.js (see TESTING-GUIDE.md)
│   ├── ambulance blood booking clinicalCoding clinicalConsent diagnostic doctorDashboard doctorPortfolio
│   ├── emr medicalDocuments patientMedicine payment pharmacy recordAccess security storage workbenchRx
├── uploads/                              local-driver upload root (git-ignored; created at runtime)
└── storage-migration/                    runtime state of the Cloudinary migration script (git-ignored)
```

Local scratch files that may exist in a developer's `backend/` (`server*.log`, `srv.*`, `token*.txt`, `storage-cleanup.jsonl`) are ignored by the root `.gitignore` / `backend/.gitignore` and are not part of the application. Real `.env`, `.env.test` files are likewise never committed; this documentation does not read them.

## Where to add things

| You are adding | Put it in |
|---|---|
| A new endpoint | `routes/<feature>.routes.js` -> `validators/` schema -> thin controller -> `services/` -> serializer in `utils/serializers.js`; mount in `routes/index.js` |
| A new table | model in `models/`, associations in `models/index.js`, a numbered SQL file in `db/migrations/`, and (if it must exist on existing databases without a deploy-time migrate) an `ensure*` guard wired in `server.js` |
| A new env variable | `config/env.js` (Joi) first - no other file may read `process.env` (verified: only `env.js` and test helpers do) |
| A new role | `ROLES` in `config/constants.js`, migration widening `users.role`, and an `ensure*` guard that runs last (later guards must not narrow the enum) |

## Per-folder file lists

### `routes/` (44)
adminAllClinics, adminAmbulance, adminBloodBank, adminClinic, adminContact, adminDashboard, adminDiagnostic, adminDoctor, adminDoctorManage, adminIcd, adminMedicine, adminRegistry, ambulance, ambulanceProvider, auth, blood, bloodBank, clinic, clinicPortal, contact, diagnostic, doctor, doctorAnalytics, doctorBooking, doctorDashboard, doctorEmr, doctorMedicine, doctorPrescription, doctorRecordAccess, doctorsPublic, file, medicineCart, medicineNotification, medicineOrder, medicineStore, patient, patientAcquisition, patientDashboard, patientEmr, patientMedicine, patientRecordAccess, pharmacy, prescriptionRequest, webhook.

### `controllers/` (58)
acquisition, adminAllClinics, adminAmbulance, adminAuth, adminBloodBank, adminClinic, adminContact, adminDiagnostic, adminDoctor, adminDoctorManage, adminIcd, adminMedicine, adminRegistry, ambulanceProvider, ambulancePublic, auth, bloodBank, bloodPatient, booking, clinic, clinicAuth, clinicPatient, clinicPortal, contact, dashboard, diagnostic, doctor, doctorAnalytics, doctorBooking, doctorMedicine, doctorReferral, doctorTimeline, earnings, emr, file, followUp, followUpReminder, medicineAuth, medicineCart, medicineNotification, medicineOrder, medicineStore, patient, patientFollowUp, patientJourney, patientMedicine, patientPrescription, patientTimeline, paymentQr, paymentWebhook, pharmacy, prescription, prescriptionRequest, prescriptionTemplate, publicDoctor, recordAccess, session, videoWebhook (each `*.controller.js`).

### `validators/` (33)
admin, adminMedicine, ambulance, auth, bloodBank, booking, clinic, clinicPortal, clinicalNote, contact, dashboard, diagnostic, doctor, doctorAnalytics, doctorMedicine, emr, followUp, followUpReminder, icdCode, medicineCart, medicineOrder, medicineStore, patient, patientMedicine, paymentQr, pharmacy, prescription, prescriptionRequest, publicDoctor, recordAccess, referral, session, timeline (each `*.validator.js`).

Services are grouped by domain in [MODULES-AND-SERVICES.md](MODULES-AND-SERVICES.md); models in [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md).
