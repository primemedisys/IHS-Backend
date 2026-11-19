/**
 * Clinical-notes business logic. Access is BOOKING-scoped but data is
 * PATIENT-wide: a doctor reaches the notes through one of their appointments,
 * and sees the patient's ENTIRE note history (every doctor, every visit). This
 * mirrors the patient-snapshot gate — notes unlock only for a confirmed or
 * completed booking the doctor actually owns, so an unpaid hold leaks nothing.
 *
 * Notes are append-only: create + list, no update/delete (a medical record).
 *
 * Since the clinic portal, a note can also be authored by a CLINIC, which has
 * neither a booking nor a doctor — see `createForPatient`.
 */
const { ClinicalNote, Booking, User } = require("../models");
const ApiError = require("../utils/ApiError");
const { BOOKING_STATUS, RECORD_SOURCES } = require("../config/constants");

const UNLOCKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];

/**
 * Who to show next to each note.
 *
 * `author` is the doctor (NULL on a clinic-written note); `recordedBy` is the
 * actual author whatever their role, and is what the UI should prefer. Both are
 * loaded because `author` predates provenance and existing views read it.
 */
const withAuthor = { model: User, as: "author", attributes: ["id", "name"] };
const withRecordedBy = { model: User, as: "recordedBy", attributes: ["id", "name", "role"] };
const authorIncludes = [withAuthor, withRecordedBy];

/**
 * Every note on a patient's record, newest first. The ONE query behind all three
 * read paths — they differ only in how they prove the caller may look, never in
 * what they return, so the doctor, the patient and the clinic can't drift into
 * showing different histories.
 */
function listForPatient(patientId, { scoped } = {}) {
  return ClinicalNote.findAll({
    // `scoped` = a doctor's consent filter (migration 057); absent for patient / clinic.
    where: scoped ? { patientId, ...scoped } : { patientId },
    include: authorIncludes,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
}

/**
 * Resolve the patient behind one of the doctor's own bookings, enforcing the
 * same unlock rule as the patient snapshot. Returns the owned booking row.
 */
async function assertBookingUnlocked(doctorId, bookingId) {
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

/** Every note for the booking's patient, newest first, with each author. */
async function listForBookingPatient(doctorId, bookingId) {
  const booking = await assertBookingUnlocked(doctorId, bookingId);
  // Own notes always; other authors' only with the `doctor_notes` grant, and
  // their diagnosis / history lines only with those grants (migration 057).
  const access = require("./clinicalAccess.service");
  const scope = await access.scopeFor(doctorId, booking.patientId);
  const notes = await listForPatient(booking.patientId, { scoped: access.clinicalNoteWhere(scope) });
  for (const n of notes) {
    if (scope.isOwn(n.doctorId)) continue;
    if (!scope.has("diagnoses")) n.setDataValue("diagnosis", null);
    if (!scope.has("medical_history")) {
      n.setDataValue("historyMedical", null);
      n.setDataValue("historySurgical", null);
    }
    // The treatment line is the medication plan.
    if (!scope.has("medications")) n.setDataValue("treatment", null);
  }
  return notes;
}

/**
 * A patient reading their OWN clinical notes (read-only). Access is gated by one
 * of the patient's bookings (so the caller proves ownership + a real relationship),
 * but the data is PATIENT-WIDE — every note on the patient's record, mirroring the
 * doctor's view. Scoping to a single booking hid notes written during other visits,
 * which just reads as "no notes". Ownership is a WHERE clause — another patient's
 * booking simply 404s.
 */
async function listForPatientBooking(patientId, bookingId) {
  const booking = await Booking.findOne({ where: { id: bookingId, patientId }, attributes: ["id"] });
  if (!booking) throw ApiError.notFound("Booking not found");
  return listForPatient(patientId);
}

/** Map a validated note body → a row payload. ONE source of truth for the shape. */
function noteRow(data) {
  const v = data.vitals || {};
  return {
    complaints: data.complaints || null,
    onExamination: data.onExamination || null,
    historyMedical: data.historyMedical || null,
    historySurgical: data.historySurgical || null,
    diagnosis: data.diagnosis || null,
    treatment: data.treatment || null,
    bloodPressure: v.bloodPressure || null,
    pulseRateBpm: v.pulseRateBpm ?? null,
    weightKg: v.weightKg ?? null,
    heightCm: v.heightCm ?? null,
    temperatureF: v.temperatureF ?? null,
    spo2Percent: v.spo2Percent ?? null,
  };
}

/** Append a note to the booking's patient, authored by this doctor. */
async function createForBookingPatient(doctorId, bookingId, data) {
  const booking = await assertBookingUnlocked(doctorId, bookingId);
  const note = await ClinicalNote.create({
    patientId: booking.patientId,
    doctorId,
    bookingId: booking.id,
    source: RECORD_SOURCES.DOCTOR,
    recordedByUserId: doctorId,
    ...noteRow(data),
  });
  return ClinicalNote.findByPk(note.id, { include: authorIncludes });
}

/**
 * Append a note authored by a CLINIC — no doctor, no booking.
 *
 * `doctorId` is NULL because that column FKs doctor_profiles(user_id), which a
 * clinic's users.id would violate (migration 018 made it nullable for exactly
 * this). `bookingId` is NULL because the clinic wrote it at the counter, not
 * from an appointment.
 *
 * CONSEQUENCE, by design: `attachConsultationArtifacts` matches notes on
 * `bookingId IN (...)`, so a clinic note will never appear as a treatment
 * TIMELINE row — the timeline's spine is bookings. It is rendered from the
 * patient-keyed read on the Records page instead, in both the patient and the
 * clinic apps.
 */
async function createForPatient(patientId, clinicUserId, data) {
  const note = await ClinicalNote.create({
    patientId,
    doctorId: null,
    bookingId: null,
    source: RECORD_SOURCES.CLINIC,
    recordedByUserId: clinicUserId,
    ...noteRow(data),
  });
  return ClinicalNote.findByPk(note.id, { include: authorIncludes });
}

module.exports = {
  listForPatient,
  listForBookingPatient,
  listForPatientBooking,
  createForBookingPatient,
  createForPatient,
};
