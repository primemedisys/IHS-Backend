/**
 * /patient routes (docs/booking-payments). Patient-owned surface: the profile
 * the booking gate reads, and (later plans) the patient's bookings. Every route
 * is guarded `authenticate` + `authorize('patient')`; validation is declared
 * HERE so controllers stay thin.
 */
const router = require("express").Router();

const patient = require("../controllers/patient.controller");
const booking = require("../controllers/booking.controller");
const session = require("../controllers/session.controller");
const prescription = require("../controllers/patientPrescription.controller");
const journey = require("../controllers/patientJourney.controller");
const timeline = require("../controllers/patientTimeline.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const upload = require("../middlewares/upload");
const schema = require("../validators/patient.validator");
const bookingSchema = require("../validators/booking.validator");
const paymentQrSchema = require("../validators/paymentQr.validator");
const timelineSchema = require("../validators/timeline.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];

// ── Profile (the booking prerequisite, PRD §4.5) ─────────────────────────────
router
  .route("/profile")
  .all(...guard)
  .get(patient.getProfile)
  .put(validate(schema.updateProfile), patient.updateProfile);

// ── Health records (docs/patient-health-records) ─────────────────────────────
router
  .route("/allergies")
  .all(...guard)
  .get(patient.getAllergies)
  .put(validate(schema.setAllergies), patient.setAllergies);

router
  .route("/conditions")
  .all(...guard)
  .get(patient.getConditions)
  .put(validate(schema.setConditions), patient.setConditions);

router
  .route("/medications")
  .all(...guard)
  .get(patient.getMedications)
  .post(validate(schema.createMedication), patient.addMedication)
  // Collection-level: the "no current medications" answer. Checking it clears
  // the list, so it is a write on the collection rather than on any one row.
  .patch(validate(schema.setNoCurrentMedications), patient.setNoCurrentMedications);
router.patch("/medications/:id", ...guard, validate(schema.updateMedication), patient.updateMedication);
router.delete("/medications/:id", ...guard, patient.deleteMedication);

router
  .route("/records")
  .all(...guard)
  .get(patient.getRecords)
  .post(validate(schema.addRecord), patient.addRecord);
// Multipart file variant (upload.single BEFORE validate so req.body text
// fields exist when Joi checks them — same ordering rule as doctor gallery).
router.post("/records/upload", ...guard, upload.single("file"), validate(schema.uploadRecord), patient.uploadRecord);
// Profile photo (multipart) — mirrors POST /doctor/photo.
router.post("/photo", ...guard, upload.single("file"), patient.uploadPhoto);
// Metadata-only edit (date of test / type / label). The file is immutable.
router.patch("/records/:id", ...guard, validate(schema.updateRecord), patient.updateRecord);
// Replace the file behind one of the patient's own documents (same upload
// middleware: mimetype allowlist, size limit, content-signature check).
router.put("/records/:id/file", ...guard, upload.single("file"), patient.replaceRecordFile);
router.delete("/records/:id", ...guard, patient.deleteRecord);

router
  .route("/vitals")
  .all(...guard)
  .get(patient.getVitals)
  .post(validate(schema.addVitalsEntry), patient.addVitals);

// ── Bookings ─────────────────────────────────────────────────────────────────
router
  .route("/bookings")
  .all(...guard)
  .get(booking.list)
  .post(validate(bookingSchema.createBooking), booking.create);

router.get("/bookings/:id", ...guard, booking.getOne);
// Where I stand in the day's queue — position, who is being seen, rough ETA.
// Polled by the patient app while the session is today and running.
router.get("/bookings/:id/queue", ...guard, session.myQueue);
router.post(
  "/bookings/:id/pay/verify",
  ...guard,
  validate(bookingSchema.verifyPayment),
  booking.verify
);
router.post("/bookings/:id/cancel", ...guard, validate(bookingSchema.cancelBooking), booking.cancel);
// Paying the doctor's own UPI QR (migration 044): the QR + amount + reference
// for one of the patient's OWN upi_qr bookings, and the "I have paid" report
// (recorded for the doctor to verify — it never changes any status).
router.get("/bookings/:id/payment-qr", ...guard, booking.paymentQr);
router.post(
  "/bookings/:id/payment-report",
  ...guard,
  validate(paymentQrSchema.reportPayment),
  booking.reportPayment
);

// The doctor's consultation notes for one of the patient's own bookings (read-only).
router.get("/bookings/:id/clinical-notes", ...guard, booking.clinicalNotes);

// A LiveKit join token for the patient's own confirmed video consult (docs/video-consultation).
router.post("/bookings/:id/video-token", ...guard, booking.videoToken);

// ── Prescriptions (read-only; drafts are never returned) ─────────────────────
router.get("/prescriptions", ...guard, prescription.list);
router.get("/prescriptions/:id/pdf", ...guard, prescription.pdf);
router.get("/prescriptions/:id", ...guard, prescription.getOne);

// ── Care journeys (docs/multi-doctor-referrals) — the whole multi-doctor flow ─
router.get("/journeys", ...guard, journey.list);
router.get("/journeys/:id", ...guard, journey.getOne);

// ── Treatment timeline (docs/treatment-timeline) — the FLAT lens over the same
// consultations the journeys group. One row per completed visit.
router.get("/timeline", ...guard, validateQuery(timelineSchema.listTimeline), timeline.list);

// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────
const patientFollowUp = require("../controllers/patientFollowUp.controller");
const followUpReminderSchema = require("../validators/followUpReminder.validator");

router.get("/follow-ups/upcoming", ...guard, patientFollowUp.listUpcoming);
router.patch("/profile/whatsapp-opt-in", ...guard, validate(followUpReminderSchema.toggleWhatsAppOptIn), patientFollowUp.toggleWhatsAppOptIn);

module.exports = router;
