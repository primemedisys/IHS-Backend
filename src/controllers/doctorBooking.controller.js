/**
 * Doctor appointment controllers — deliberately THIN. Read `req.doctorId` (set
 * by resolveDoctorId) + validated input, call one booking.service function,
 * serialize. The patient snapshot is only attached when the service says the
 * booking is confirmed/completed.
 */
const bookingService = require("../services/booking.service");
const clinicalNoteService = require("../services/clinicalNote.service");
const vitalsService = require("../services/patientVitals.service");
const patientService = require("../services/patient.service");
const videoSessionService = require("../services/videoSession.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { ROLES } = require("../config/constants");
const {
  serializeBookingForDoctor,
  serializePatientSnapshot,
  serializeClinicalNote,
  serializePatientVitals,
  serializeUploadedRecord,
  serializeVideoToken,
} = require("../utils/serializers");

exports.list = asyncHandler(async (req, res) => {
  const rows = await bookingService.listForDoctor(req.doctorId, {
    status: req.query.status,
    date: req.query.date,
    clinicId: req.query.clinicId,
  });
  return ok(res, rows.map(serializeBookingForDoctor), "Appointments");
});

exports.getOne = asyncHandler(async (req, res) => {
  const { booking, showSnapshot } = await bookingService.getForDoctorWithPatientSnapshot(
    req.doctorId,
    req.params.id
  );
  return ok(
    res,
    {
      booking: serializeBookingForDoctor(booking),
      patient: showSnapshot ? serializePatientSnapshot(booking.patient) : null,
    },
    "Appointment"
  );
});

exports.markPaid = asyncHandler(async (req, res) => {
  const booking = await bookingService.markPaid(req.doctorId, req.params.id);
  return ok(res, serializeBookingForDoctor(booking), "Marked as paid");
});

exports.complete = asyncHandler(async (req, res) => {
  const booking = await bookingService.complete(req.doctorId, req.params.id, req.body);
  return ok(
    res,
    serializeBookingForDoctor(booking),
    booking.status === "no_show" ? "Marked as no-show" : "Marked complete"
  );
});

// ── Clinical notes (patient-wide log, reached from this appointment) ──────────
exports.listClinicalNotes = asyncHandler(async (req, res) => {
  const rows = await clinicalNoteService.listForBookingPatient(req.doctorId, req.params.id);
  return ok(res, rows.map(serializeClinicalNote), "Clinical notes");
});

exports.addClinicalNote = asyncHandler(async (req, res) => {
  const note = await clinicalNoteService.createForBookingPatient(req.doctorId, req.params.id, req.body);
  return created(res, serializeClinicalNote(note), "Clinical note added");
});

/**
 * Move a confirmed appointment to another time (the doctor can't make the
 * original slot). The new slot goes through the same validation a patient
 * booking does, so it lands somewhere genuinely bookable.
 */
exports.reschedule = asyncHandler(async (req, res) => {
  const { booking, from } = await bookingService.reschedule(req.doctorId, req.params.id, req.body);
  return ok(
    res,
    { booking: serializeBookingForDoctor(booking), from },
    `Appointment moved from ${from.date} ${from.startTime}`
  );
});

// ── Patient vitals timeline (the record table, reached from this appointment) ──
// `age` rides along so the doctor bands an identical reading identically to the
// patient's own view (docs/vitals-reference-ranges §4).
exports.listPatientVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await vitalsService.listForBookingPatient(req.doctorId, req.params.id);
  return ok(res, serializePatientVitals(rows, { age }), "Patient vitals");
});

exports.addPatientVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await vitalsService.addForBookingPatient(
    req.doctorId,
    req.params.id,
    req.body
  );
  return created(res, serializePatientVitals(rows, { age }), "Reading added");
});

// A doctor correcting the DATE a document speaks for (a prescription uploaded
// today may be dated weeks back). Same booking gate as the vitals above.
exports.updatePatientRecord = asyncHandler(async (req, res) => {
  const row = await patientService.updateRecordDateForDoctor(
    req.doctorId,
    req.params.id,
    req.params.recordId,
    req.body.recordDate
  );
  return ok(res, serializeUploadedRecord(row), "Record date updated");
});

// ── Video consultation ────────────────────────────────────────────────────────
// A LiveKit join token for the doctor's own confirmed video consult, in-window.
exports.videoToken = asyncHandler(async (req, res) => {
  const result = await videoSessionService.mintToken({
    bookingId: req.params.id,
    actorId: req.doctorId,
    role: ROLES.DOCTOR,
  });
  return ok(res, serializeVideoToken(result), "Video token");
});
