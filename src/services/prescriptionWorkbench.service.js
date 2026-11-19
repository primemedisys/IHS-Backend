/**
 * Patient Workbench → prescription (migration 059).
 *
 * The active consultation in the Workbench is the source of truth for a
 * prescription. This reads — never writes — the Workbench record of ONE
 * consultation (the prescription's own booking, owned by the prescription's
 * own doctor, for the prescription's own patient) and returns it as the
 * clinical snapshot (utils/serializers#buildWorkbenchSnapshot).
 *
 * `syncDraft` then copies the printable parts onto a DRAFT prescription
 * (chief complaint, diagnosis line, vitals, follow-up date, advice from the
 * published doctor's notes) and stores the whole snapshot. Medicines need no
 * copy: the Workbench Medication Order writes this same draft's items.
 * Investigations and the follow-up instructions are printed from the stored
 * snapshot (printed.investigations / printed.followUpNote). A field the Workbench has nothing for keeps the
 * prescription's own value, so prescriptions written outside the Workbench
 * keep working. Finalize runs it one last time inside its transaction, so the
 * signed document carries exactly what the Workbench held at signing.
 *
 * Vitals, in order: readings taken IN this consultation; else the patient's
 * latest reading this doctor may see (consent scope, migration 057), labelled
 * with its own date. Only a reading of this consultation, or one taken on the
 * consultation day, is printed — an older one is shown, never presented as
 * today's.
 */
const { Op } = require("sequelize");
const {
  Booking,
  User,
  PatientProfile,
  Clinic,
  DoctorProfile,
  Specialization,
  ClinicalEntry,
  PatientVitals,
  PatientFollowUp,
} = require("../models");
const access = require("./clinicalAccess.service");
const { buildWorkbenchSnapshot } = require("../utils/serializers");
const {
  CLINICAL_ENTRY_KIND: K,
  CLINICAL_ENTRY_STATUS,
  EXAMINATION_FORMS,
  HISTORY_CATEGORIES,
  COMORBIDITY_CATEGORIES,
  PRESCRIPTION_STATUS,
} = require("../config/constants");

const NEWEST = [
  ["recordedOn", "DESC"],
  ["recordedAt", "DESC"],
  ["createdAt", "DESC"],
  ["id", "DESC"],
];

/** Everything the snapshot needs, in a fixed number of queries (no per-entry reads). */
async function gather(rx) {
  if (!rx.bookingId) return null;
  const { bookingId, doctorId, patientId } = rx;
  const [booking, patient, entries, visitVitals, followUp] = await Promise.all([
    Booking.findOne({
      // The prescription's own doctor AND patient — never another consultation's.
      where: { id: bookingId, doctorId, patientId },
      include: [
        { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
        {
          model: DoctorProfile,
          as: "doctor",
          attributes: ["userId", "qualification"],
          include: [
            { model: User, as: "user", attributes: ["id", "name"] },
            { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name"] },
          ],
        },
      ],
    }),
    User.findByPk(patientId, {
      attributes: ["id", "name", "phone"],
      include: [{ model: PatientProfile, as: "patientProfile" }],
    }),
    ClinicalEntry.findAll({
      where: {
        bookingId,
        patientId,
        doctorId,
        status: CLINICAL_ENTRY_STATUS.ACTIVE,
        [Op.or]: [
          { kind: { [Op.in]: [K.COMPLAINT, K.EXAMINATION, K.DIAGNOSIS, K.HISTORY, K.COMORBIDITY, K.INVESTIGATION] } },
          // Doctor's notes only once PUBLISHED: a private note never leaves the
          // Workbench, not even into the doctor-only snapshot.
          { kind: K.DOCTOR_NOTE, patientVisible: true },
        ],
      },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
    }),
    PatientVitals.findAll({ where: { patientId, bookingId }, order: NEWEST, limit: 20 }),
    PatientFollowUp.findOne({ where: { bookingId } }),
  ]);
  if (!booking || !patient) return null;

  let vitalRows = visitVitals;
  let vitalSource = visitVitals.length ? "consultation" : "none";
  if (!visitVitals.length) {
    const scoped = await access.vitalsWhere(await access.scopeFor(doctorId, patientId));
    const latest = await PatientVitals.findOne({ where: { patientId, [Op.and]: [scoped] }, order: NEWEST });
    if (latest) {
      vitalRows = [latest];
      vitalSource = latest.recordedOn === booking.slotDate ? "same_day" : "earlier";
    }
  }

  return {
    booking,
    patient,
    entries,
    vitalRows,
    vitalSource,
    followUp,
    examForms: EXAMINATION_FORMS,
    historyCategories: HISTORY_CATEGORIES,
    comorbidityCategories: COMORBIDITY_CATEGORIES,
  };
}

/** The Workbench snapshot for a prescription (read-only). Null when it has no consultation. */
async function snapshotFor(rx) {
  const raw = await gather(rx);
  return raw ? buildWorkbenchSnapshot(raw) : null;
}

/**
 * Refresh a DRAFT from its Workbench consultation. Returns the snapshot (or
 * null when the prescription has no consultation). A finalized prescription is
 * never touched — its snapshot is the one frozen at signing.
 */
async function syncDraft(rx, { transaction } = {}) {
  if (rx.status !== PRESCRIPTION_STATUS.DRAFT) return rx.clinicalSnapshot ?? null;
  const snapshot = await snapshotFor(rx);
  if (!snapshot) return null;
  const { printed } = snapshot;
  const patch = { clinicalSnapshot: snapshot };
  if (printed.chiefComplaint) patch.chiefComplaint = printed.chiefComplaint;
  if (printed.diagnosis) patch.diagnosis = printed.diagnosis;
  if (printed.vitals) Object.assign(patch, printed.vitals);
  if (printed.followUpDate) patch.followUpDate = printed.followUpDate;
  // Published doctor's notes are the prescription's advice (private notes never are).
  if (printed.advice) patch.advice = printed.advice;
  await rx.update(patch, { transaction });
  return snapshot;
}

module.exports = { snapshotFor, syncDraft, gather };
