/**
 * Patient vitals timeline — the rows behind the "record table"
 * (docs/patient-health-records). A patient logs a dated reading (BP, pulse,
 * weight, height, temp, SpO₂); the matrix is those readings as columns.
 *
 * Two writers and two readers: the patient's OWN list, and a doctor's
 * BOOKING-scoped read/write of a patient's timeline. The doctor gate mirrors
 * clinical-notes / the snapshot — the booking must be the doctor's own and
 * confirmed/completed, so an unpaid hold leaks nothing. Doctor-logged rows carry
 * source "doctor" (the record table tags them "clinic"); the model treats
 * patient- and doctor-recorded readings as interchangeable.
 */
const { Op } = require("sequelize");
const { PatientVitals, PatientProfile, Booking, User } = require("../models");
const ApiError = require("../utils/ApiError");
const { ageFrom } = require("../utils/age");
const { istToday } = require("../utils/period");
const { BOOKING_STATUS, RECORD_SOURCES } = require("../config/constants");

const UNLOCKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];

const ORDER = [
  ["recordedOn", "DESC"],
  ["createdAt", "DESC"],
  ["id", "DESC"],
];

/** Map a validated vitals body → a patient_vitals row payload (one source of truth). */
/** "120/80" from the 051 systolic/diastolic pair, so every older view still reads it. */
function composedBp(body) {
  if (body.bloodPressure) return body.bloodPressure;
  if (body.bpSystolic != null && body.bpDiastolic != null) return `${body.bpSystolic}/${body.bpDiastolic}`;
  return null;
}

const vitalsRow = (patientId, body, source, recordedByUserId = null) => ({
  patientId,
  recordedOn: body.recordedOn,
  // Migration 051 — absent from the patient/clinic forms, so NULL there.
  recordedAt: body.recordedAt ?? null,
  bookingId: body.bookingId ?? null,
  bpSystolic: body.bpSystolic ?? null,
  bpDiastolic: body.bpDiastolic ?? null,
  heartRateBpm: body.heartRateBpm ?? null,
  respiratoryRate: body.respiratoryRate ?? null,
  waistCm: body.waistCm ?? null,
  hipCm: body.hipCm ?? null,
  headCircumferenceCm: body.headCircumferenceCm ?? null,
  bloodPressure: composedBp(body),
  pulseRateBpm: body.pulseRateBpm ?? null,
  weightKg: body.weightKg ?? null,
  heightCm: body.heightCm ?? null,
  temperatureF: body.temperatureF ?? null,
  spo2Percent: body.spo2Percent ?? null,
  note: body.note || null,
  location: body.location || null,
  source,
  // Who actually entered it (migration 018). NULL on every pre-existing row.
  recordedByUserId,
});

/**
 * The patient's age, for the reference-range gate
 * (docs/vitals-reference-ranges §4 — adult bands only). Loaded ONCE per
 * request alongside the rows, never per entry.
 *
 * Age is computed as of TODAY, not as of `recordedOn`: a reading taken at 17 is
 * evaluated against adult ranges once the patient turns 18. Deliberate v1
 * simplification — age-at-reading is more correct and is a noted follow-up.
 */
async function ageOf(patientId) {
  const profile = await PatientProfile.findByPk(patientId, { attributes: ["dateOfBirth"] });
  return ageFrom(profile?.dateOfBirth);
}

/**
 * Every reading for a patient, newest first (matrix columns left→right), plus
 * the age the serializer needs to band them. Returns `{ rows, age }` — every
 * read path must carry the age through, or the whole table silently degrades to
 * `unknown`, which looks like "the feature is broken" rather than an error.
 */
async function listForPatient(patientId, { scoped } = {}) {
  const [rows, age] = await Promise.all([
    PatientVitals.findAll({
      // `scoped` = a doctor's consent filter (migration 057); absent for the patient / clinic.
      where: scoped ? { patientId, [Op.and]: [scoped] } : { patientId },
      // LEFT JOIN so the source chip can name the author. Must stay a LEFT
      // join: recorded_by_user_id is ON DELETE SET NULL, and a reading whose
      // author was deleted still belongs on the timeline.
      include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
      order: ORDER,
    }),
    ageOf(patientId),
  ]);
  return { rows, age };
}

/** Append a patient-recorded reading, then return the refreshed timeline. */
async function addForPatient(patientId, body) {
  await PatientVitals.create(vitalsRow(patientId, body, RECORD_SOURCES.PATIENT, patientId));
  return listForPatient(patientId);
}

/**
 * A CLINIC logging a reading onto the patient's timeline. Identical row shape to
 * the patient's and the doctor's — only the provenance differs, which is exactly
 * what the source chip renders.
 */
async function addForPatientByClinic(patientId, body, clinicUserId) {
  await PatientVitals.create(vitalsRow(patientId, body, RECORD_SOURCES.CLINIC, clinicUserId));
  return listForPatient(patientId);
}

/**
 * A doctor's consent filter over the patient's readings (migration 057).
 * Required lazily: clinicalAccess → appointmentNotification must not load
 * while this module is still initialising.
 */
async function doctorVitalsScope(doctorId, patientId) {
  const access = require("./clinicalAccess.service");
  return access.vitalsWhere(await access.scopeFor(doctorId, patientId));
}

/**
 * Load a doctor's OWN booking and assert the patient's timeline is unlocked
 * (confirmed/completed). The single gate both the read and the write share.
 */
async function gateBookingPatient(doctorId, bookingId) {
  const booking = await Booking.findOne({
    where: { id: bookingId, doctorId },
    attributes: ["id", "patientId", "status"],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (!UNLOCKED.includes(booking.status)) {
    throw ApiError.forbidden("Patient details unlock once the booking is confirmed");
  }
  return booking;
}

/**
 * A doctor reading the timeline of the patient behind one of their own
 * bookings. Same unlock rule as the patient snapshot / clinical notes.
 */
async function listForBookingPatient(doctorId, bookingId) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  // Same `{ rows, age }` shape as the patient's own read, so BOTH views band
  // an identical reading identically — a doctor and a patient seeing different
  // verdicts on one number is the specific failure this feature prevents.
  return listForPatient(booking.patientId, { scoped: await doctorVitalsScope(doctorId, booking.patientId) });
}

/**
 * A doctor logging a reading onto that same timeline (source "doctor"). Returns
 * the refreshed timeline so the caller serializes the whole matrix in one go.
 */
async function addForBookingPatient(doctorId, bookingId, body) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  await PatientVitals.create(
    vitalsRow(booking.patientId, { ...body, bookingId: booking.id }, RECORD_SOURCES.DOCTOR, doctorId)
  );
  return listForPatient(booking.patientId, { scoped: await doctorVitalsScope(doctorId, booking.patientId) });
}

/**
 * The EMR "Add vitals" form (migration 051): the full measurement set, the
 * exact time of the reading, tied to THIS visit. Appends a new row — never
 * overwrites an older reading. Empty fields stay NULL (never a fabricated 0).
 */
async function addEmrReading(doctorId, bookingId, body) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  const at = body.recordedAt ? new Date(body.recordedAt) : new Date();
  const row = await PatientVitals.create(
    vitalsRow(
      booking.patientId,
      { ...body, recordedAt: at, recordedOn: istToday(at), bookingId: booking.id },
      RECORD_SOURCES.DOCTOR,
      doctorId
    )
  );
  return { patientId: booking.patientId, id: row.id };
}

module.exports = {
  listForPatient,
  addForPatient,
  addForPatientByClinic,
  listForBookingPatient,
  addForBookingPatient,
  addEmrReading,
  // Shared with treatmentTimeline.service so a doctor reaching a patient
  // THROUGH one of their bookings is gated identically everywhere.
  gateBookingPatient,
};
