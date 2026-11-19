/**
 * The clinic's PATIENT workspace: the directory, one patient's record, the
 * writes a clinic may make, and booking an appointment on their behalf.
 *
 * Every route behind this controller has already passed `authorize(CLINIC)` +
 * `requireApprovedClinic` (which sets `req.clinicId`) and, where a patient is
 * named, `resolveClinicPatient` (which sets `req.patientId` or 404s). So no
 * handler here re-checks access — it is proven by the route.
 *
 * Almost every read reuses the SAME service function the patient's own app
 * calls. That is the point: a clinic cannot see a different version of a
 * patient's record than the patient does.
 */
const userService = require("../services/user.service");
const patientService = require("../services/patient.service");
const patientVitalsService = require("../services/patientVitals.service");
const clinicalNoteService = require("../services/clinicalNote.service");
const treatmentTimelineService = require("../services/treatmentTimeline.service");
const bookingService = require("../services/booking.service");
const videoSessionService = require("../services/videoSession.service");
const prescriptionService = require("../services/prescription.service");
const { streamPdf } = require("./prescription.controller");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok, created } = require("../utils/apiResponse");
const { RECORD_SOURCES, ROLES } = require("../config/constants");
const {
  serializeClinicPatientRow,
  serializePatientSnapshot,
  serializePatientVitals,
  serializeUploadedRecord,
  serializeAllergyEntry,
  serializeConditionEntry,
  serializeClinicalNote,
  serializeTimeline,
  serializeBookingForPatient,
  serializeVideoToken,
} = require("../utils/serializers");

/** The provenance stamp every write from this controller carries. */
const clinicAuthor = (req) => ({ source: RECORD_SOURCES.CLINIC, userId: req.clinicId });

// ── Directory ────────────────────────────────────────────────────────────────

/**
 * Search / browse every registered patient.
 *
 * Query params come off `req.query`, which Express 5 makes read-only — hence
 * `validateQuery` on the route rather than the reassigning `validate`.
 */
exports.listPatients = asyncHandler(async (req, res) => {
  // `validatedQuery`, not `query`: validateQuery publishes the coerced result
  // there because Express 5's req.query has no setter.
  const result = await userService.searchPatients(req.validatedQuery);
  return ok(
    res,
    { ...result, data: result.data.map(serializeClinicPatientRow) },
    "Patients"
  );
});

// ── One patient's record ─────────────────────────────────────────────────────

exports.getPatient = asyncHandler(async (req, res) => {
  // The same snapshot a doctor sees in a consultation. It already omits email.
  const snapshot = await patientService.getSnapshotForClinic(req.patientId);
  return ok(res, serializePatientSnapshot(snapshot), "Patient");
});

exports.getTimeline = asyncHandler(async (req, res) => {
  const timeline = await treatmentTimelineService.listForClinicPatient(req.patientId, req.validatedQuery);
  return ok(res, serializeTimeline(timeline), "Treatment timeline");
});

exports.getVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await patientVitalsService.listForPatient(req.patientId);
  return ok(res, serializePatientVitals(rows, { age }), "Vitals");
});

exports.addVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await patientVitalsService.addForPatientByClinic(
    req.patientId,
    req.body,
    req.clinicId
  );
  return created(res, serializePatientVitals(rows, { age }), "Reading recorded");
});

exports.getRecords = asyncHandler(async (req, res) => {
  const rows = await patientService.getRecords(req.patientId);
  return ok(res, rows.map(serializeUploadedRecord), "Reports & documents");
});

exports.addRecord = asyncHandler(async (req, res) => {
  const row = await patientService.addRecord(req.patientId, req.body, clinicAuthor(req));
  return created(res, serializeUploadedRecord(row), "Record added");
});

exports.uploadRecord = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("A file is required");
  const row = await patientService.uploadRecord(
    req.patientId,
    req.file,
    req.body,
    clinicAuthor(req)
  );
  return created(res, serializeUploadedRecord(row), "Record uploaded");
});

exports.getAllergies = asyncHandler(async (req, res) => {
  const rows = await patientService.getAllergies(req.patientId);
  return ok(res, rows.map(serializeAllergyEntry), "Allergies");
});

/**
 * ADD allergies — never replace. The patient's own endpoint is a PUT that
 * rewrites the whole set, which is right for a form showing every row and
 * catastrophic here: the clinic is showing none of them.
 */
exports.addAllergies = asyncHandler(async (req, res) => {
  const rows = await patientService.addAllergiesFor(req.patientId, req.body, clinicAuthor(req));
  return created(res, rows.map(serializeAllergyEntry), "Allergies added");
});

exports.getConditions = asyncHandler(async (req, res) => {
  const rows = await patientService.getConditions(req.patientId);
  return ok(res, rows.map(serializeConditionEntry), "Conditions");
});

exports.addConditions = asyncHandler(async (req, res) => {
  const rows = await patientService.addConditionsFor(req.patientId, req.body, clinicAuthor(req));
  return created(res, rows.map(serializeConditionEntry), "Conditions added");
});

exports.getClinicalNotes = asyncHandler(async (req, res) => {
  const rows = await clinicalNoteService.listForPatient(req.patientId);
  return ok(res, rows.map(serializeClinicalNote), "Clinical notes");
});

exports.addClinicalNote = asyncHandler(async (req, res) => {
  const note = await clinicalNoteService.createForPatient(req.patientId, req.clinicId, req.body);
  return created(res, serializeClinicalNote(note), "Note added");
});

// ── Booking on the patient's behalf ──────────────────────────────────────────

/**
 * Fill in the patient's missing booking-required fields (phone, DOB, gender,
 * city) so a walk-in who never completed their profile can still be booked.
 *
 * Deliberately narrow: `patientService.updateProfile` whitelists its own
 * columns, and the validator here permits only that set — a clinic cannot edit
 * a patient's address, emergency contact or account.
 */
exports.updatePatientProfile = asyncHandler(async (req, res) => {
  const user = await patientService.updateProfile(req.patientId, req.body);
  const status = patientService.computeProfileStatus(user);
  return ok(res, { status }, "Patient details updated");
});

/**
 * Book an appointment FOR the patient — video or clinic.
 *
 * Reuses `bookingService.create` verbatim; the only difference from a patient
 * booking themselves is the `bookedByUserId` stamp, which is what later renders
 * "booked by X Clinic" to the doctor and "via X Clinic" to the patient. The
 * direct patient→doctor flow is not touched.
 */
exports.createBooking = asyncHandler(async (req, res) => {
  const { booking, razorpayOrder } = await bookingService.create(req.patientId, req.body, {
    bookedByUserId: req.clinicId,
  });
  return created(res, { booking: serializeBookingForPatient(booking), razorpayOrder }, "Appointment booked");
});

/** The appointments THIS clinic booked for this patient. */
exports.listBookings = asyncHandler(async (req, res) => {
  const rows = await bookingService.listForClinicPatient(req.clinicId, req.patientId);
  return ok(res, rows.map(serializeBookingForPatient), "Appointments");
});

/**
 * A LiveKit join token so the clinic can put the patient in front of the doctor
 * on its own screen.
 *
 * Scoped to bookings this clinic ARRANGED: `mintToken` matches a clinic on
 * `bookedByUserId`, so an appointment the patient booked directly simply 404s
 * here. The patient can still join from their own app either way — this adds a
 * third seat, it does not take theirs.
 */
exports.videoToken = asyncHandler(async (req, res) => {
  const result = await videoSessionService.mintToken({
    bookingId: req.params.bookingId,
    actorId: req.clinicId,
    role: ROLES.CLINIC,
  });
  return ok(res, serializeVideoToken(result), "Video token");
});

/**
 * A prescription PDF from the patient's timeline.
 *
 * Reuses `getPdfForPatient` verbatim — it scopes by patientId AND hard-filters
 * `status='finalized'`, so a clinic can never pull a doctor's unfinished draft,
 * and passing another patient's prescription id simply 404s. Zero new service
 * code, which is the point: one implementation of "which PDF may this caller
 * see" for the patient and the clinic both.
 */
exports.prescriptionPdf = asyncHandler(async (req, res) => {
  const result = await prescriptionService.getPdfForPatient(req.patientId, req.params.id);
  return streamPdf(res, result);
});
