/**
 * /doctor appointment routes (docs/booking-payments). Mounted under `/doctor`
 * alongside doctor.routes.js + clinic.routes.js. Every route is guarded
 * `authenticate` + `authorize('doctor')` + resolveDoctorId('self') so the
 * booking controllers read `req.doctorId` the same way the clinic ones do.
 */
const router = require("express").Router();

const booking = require("../controllers/doctorBooking.controller");
const referral = require("../controllers/doctorReferral.controller");
const timeline = require("../controllers/doctorTimeline.controller");
const session = require("../controllers/session.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const bookingSchema = require("../validators/booking.validator");
const clinicalNoteSchema = require("../validators/clinicalNote.validator");
const referralSchema = require("../validators/referral.validator");
const patientSchema = require("../validators/patient.validator");
const timelineSchema = require("../validators/timeline.validator");
const sessionSchema = require("../validators/session.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

// ── The consulting day (docs/consultation-queue) ─────────────────────────────
// The doctor's own sessions and the queue inside them. `/sessions` is a literal
// segment declared before the id routes, so neither can shadow the other.
router.get("/sessions", ...guard, session.listForDoctor);
router.get("/sessions/:id/queue", ...guard, session.queue);
router.post("/sessions/:id/start", ...guard, session.start);
router.post("/sessions/:id/pause", ...guard, session.pause);
router.post("/sessions/:id/resume", ...guard, session.resume);
router.post("/sessions/:id/end", ...guard, session.end);
router.post("/sessions/:id/call-next", ...guard, session.callNext);
router.patch("/sessions/:id", ...guard, validate(sessionSchema.setSessionCap), session.setCap);
// Serve one specific token — the patient standing in front of the doctor,
// whatever their number says.
router.post("/bookings/:id/start-consult", ...guard, session.startConsult);
router.post("/bookings/:id/skip", ...guard, validate(sessionSchema.skipBooking), session.skip);

router.get("/bookings", ...guard, booking.list);
router.get("/bookings/:id", ...guard, booking.getOne);
router.post("/bookings/:id/mark-paid", ...guard, booking.markPaid);
router.post("/bookings/:id/complete", ...guard, validate(bookingSchema.completeBooking), booking.complete);
// Doctor can't make the slot → move it. Only the time changes.
router.post(
  "/bookings/:id/reschedule",
  ...guard,
  validate(bookingSchema.rescheduleBooking),
  booking.reschedule
);

// Patient-wide clinical notes, reached from an appointment (access gated to the
// doctor's own confirmed/completed booking; data spans all the patient's notes).
router.get("/bookings/:id/clinical-notes", ...guard, booking.listClinicalNotes);
router.post(
  "/bookings/:id/clinical-notes",
  ...guard,
  validate(clinicalNoteSchema.createNote),
  booking.addClinicalNote
);

// The patient's TREATMENT timeline (docs/treatment-timeline §5.3), reached from
// this appointment or from the live video call. Booking-keyed on purpose: the
// patient is derived from a booking the doctor owns, so this route takes no
// patient parameter and can't be pivoted to somebody else's patient. Same
// convention (and same unlock gate) as `/bookings/:id/patient-vitals` below.
router.get(
  "/bookings/:id/patient-timeline",
  ...guard,
  validateQuery(timelineSchema.listTimeline),
  timeline.listByBooking
);

// The patient's vitals timeline (the record table), same gate. The doctor can
// also append a reading (stored as a "doctor" source, tagged "clinic").
router.get("/bookings/:id/patient-vitals", ...guard, booking.listPatientVitals);
router.post(
  "/bookings/:id/patient-vitals",
  ...guard,
  validate(patientSchema.addVitalsEntry),
  booking.addPatientVitals
);

// Correct the DATE a patient's document speaks for (e.g. a prescription
// uploaded today whose actual date is weeks back). Same gate; date only.
router.patch(
  "/bookings/:id/patient-records/:recordId",
  ...guard,
  validate(patientSchema.updateRecordDate),
  booking.updatePatientRecord
);

// Multi-doctor referrals made FROM this consultation (docs/multi-doctor-referrals).
// Same gate as the notes/Rx — a referral is made in the same breath.
router.post(
  "/bookings/:id/referrals",
  ...guard,
  validate(referralSchema.createReferral),
  referral.create
);
router.get("/bookings/:id/referrals", ...guard, referral.listForBooking);

// A LiveKit join token for the doctor's own confirmed video consult (docs/video-consultation).
router.post("/bookings/:id/video-token", ...guard, booking.videoToken);

// ── My Patients (docs/treatment-timeline §5.4) ───────────────────────────────
// The doctor app's first patients concept. The roster is DERIVED from this
// doctor's own bookings — never a listing of platform patients — and the
// per-patient timeline asserts the treating relationship before loading a row.
// `/patients` is a literal segment and the timeline is two segments deeper, so
// neither can shadow the other; no ordering hazard.
router.get("/patients", ...guard, validateQuery(timelineSchema.listPatients), timeline.listPatients);
// Manual status override (new / OPD f-u / surgery pending / surgery f-u).
router.patch(
  "/patients/:patientId/status",
  ...guard,
  validate(timelineSchema.setPatientStatus),
  timeline.setPatientStatus
);
router.get(
  "/patients/:patientId/timeline",
  ...guard,
  validateQuery(timelineSchema.listTimeline),
  timeline.listByPatient
);

module.exports = router;
