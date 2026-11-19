/**
 * /clinic routes — the clinic portal (docs/clinic-account).
 *
 * TWO guard tiers, and the difference matters:
 *
 *   ownGuard      authenticate + authorize(CLINIC)
 *                 The clinic's OWN account. Reachable while still pending,
 *                 because finishing onboarding is the whole point of pending.
 *
 *   patientGuard  ownGuard + requireApprovedClinic
 *                 Anything touching PATIENT data. A clinic self-registers, so
 *                 without the approval gate anyone with an email could read
 *                 every patient on the platform.
 *
 * `/clinic` as a URL prefix is free: the existing `clinic.routes.js` (a
 * DOCTOR'S locations) is mounted under `/doctor`.
 */
const router = require("express").Router();

const clinicPortal = require("../controllers/clinicPortal.controller");
const clinicPatient = require("../controllers/clinicPatient.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const requireApprovedClinic = require("../middlewares/requireApprovedClinic");
const resolveClinicPatient = require("../middlewares/resolveClinicPatient");
const upload = require("../middlewares/upload");
const schema = require("../validators/clinicPortal.validator");
const timelineSchema = require("../validators/timeline.validator");
const { ROLES } = require("../config/constants");

const ownGuard = [authenticate, authorize(ROLES.CLINIC)];
const patientGuard = [...ownGuard, requireApprovedClinic];
// Every `/patients/:patientId/*` route additionally 404s an unknown patient
// before the controller runs.
const oneP = [...patientGuard, resolveClinicPatient];

// ── The clinic's own account (available while pending) ───────────────────────
router
  .route("/profile")
  .all(...ownGuard)
  .get(clinicPortal.getProfile)
  .put(validate(schema.updateClinicProfile), clinicPortal.updateProfile);

router.get("/onboarding", ...ownGuard, clinicPortal.getOnboarding);
router.post("/submit", ...ownGuard, clinicPortal.submit);

router.post(
  "/documents",
  ...ownGuard,
  upload.single("file"),
  validate(schema.uploadClinicDocument),
  clinicPortal.uploadDocument
);
router.delete("/documents/:documentId", ...ownGuard, clinicPortal.deleteDocument);

// ── The patient directory (approved clinics only) ────────────────────────────
router.get("/patients", ...patientGuard, validateQuery(schema.listPatients), clinicPatient.listPatients);

// ── One patient's workspace ──────────────────────────────────────────────────
router.get("/patients/:patientId", ...oneP, clinicPatient.getPatient);

router.get(
  "/patients/:patientId/timeline",
  ...oneP,
  validateQuery(timelineSchema.listTimeline),
  clinicPatient.getTimeline
);

router
  .route("/patients/:patientId/vitals")
  .all(...oneP)
  .get(clinicPatient.getVitals)
  .post(validate(schema.addVitalsEntry), clinicPatient.addVitals);

router
  .route("/patients/:patientId/records")
  .all(...oneP)
  .get(clinicPatient.getRecords)
  .post(validate(schema.addRecord), clinicPatient.addRecord);

router.post(
  "/patients/:patientId/records/upload",
  ...oneP,
  upload.single("file"),
  validate(schema.uploadRecord),
  clinicPatient.uploadRecord
);

// POST, never PUT. The patient's own endpoint replaces the whole set, which is
// right for a form showing every row and would silently wipe the patient's
// history here — see clinicPatient.controller.addAllergies.
router
  .route("/patients/:patientId/allergies")
  .all(...oneP)
  .get(clinicPatient.getAllergies)
  .post(validate(schema.addAllergies), clinicPatient.addAllergies);

router
  .route("/patients/:patientId/conditions")
  .all(...oneP)
  .get(clinicPatient.getConditions)
  .post(validate(schema.addConditions), clinicPatient.addConditions);

router
  .route("/patients/:patientId/clinical-notes")
  .all(...oneP)
  .get(clinicPatient.getClinicalNotes)
  .post(validate(schema.createNote), clinicPatient.addClinicalNote);

// ── Booking on the patient's behalf ──────────────────────────────────────────
// PATCH first: the booking gate requires four patient fields, and a walk-in
// often has none of them filled in.
router.patch(
  "/patients/:patientId/profile",
  ...oneP,
  validate(schema.updatePatientProfile),
  clinicPatient.updatePatientProfile
);

router
  .route("/patients/:patientId/bookings")
  .all(...oneP)
  .get(clinicPatient.listBookings)
  .post(validate(schema.createBooking), clinicPatient.createBooking);

// A prescription PDF off the patient's timeline. Scoped to :patientId by the
// service, and finalized-only — a doctor's draft is never reachable.
router.get("/patients/:patientId/prescriptions/:id/pdf", ...oneP, clinicPatient.prescriptionPdf);

// The clinic joins a video consult it arranged — see clinicPatient.videoToken.
// `oneP` is not used: the token gate proves the relationship through the booking
// itself, so naming the patient in the URL would be redundant.
router.post("/bookings/:bookingId/video-token", ...patientGuard, clinicPatient.videoToken);

module.exports = router;
