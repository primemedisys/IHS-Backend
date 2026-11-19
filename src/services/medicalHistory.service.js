/**
 * The patient's structured clinical history — ONE builder behind both the
 * patient's own Medical Record page and the doctor's workbench, so the two can
 * never disagree about which diagnosis, prescription or note belongs to which
 * consultation.
 *
 * A LENS, not a store: every row already exists (bookings, clinical_entries,
 * prescriptions + items, patient_vitals, patient_follow_ups, clinical_notes).
 * Nothing is written, nothing is invented — a visit with no diagnosis simply
 * has none.
 *
 * Correct linkage: everything attached to a consultation is joined on its
 * booking_id (never on "same patient, same day"), and a prescription's prescriber
 * is the prescription's own doctor_id.
 *
 * Who sees what:
 *   patient (scope = null) — completed visits; entries the doctor made visible
 *     to them; finalized prescriptions; all their own notes and follow-ups.
 *   doctor  (scope from clinicalAccess.scopeFor) — published entries + their
 *     own drafts; their OWN records always; other doctors' records only for the
 *     categories the patient has granted them. A locked part is left out in
 *     the query, or blanked before serialization — it never leaves the server.
 *
 * Query budget is FIXED: bookings, entries, prescriptions (+ items), vitals,
 * follow-ups, legacy notes — never a query per visit.
 */
const { Op } = require("sequelize");
const {
  Booking,
  User,
  Clinic,
  DoctorProfile,
  Specialization,
  ClinicalEntry,
  ClinicalNote,
  Prescription,
  PrescriptionItem,
  PatientVitals,
  PatientFollowUp,
  FollowUpStatus,
} = require("../models");
const access = require("./clinicalAccess.service");
const {
  BOOKING_STATUS,
  PRESCRIPTION_STATUS,
  CLINICAL_ENTRY_KIND: K,
  CLINICAL_ENTRY_STATUS,
  CLINICAL_ACCESS_CATEGORY: C,
} = require("../config/constants");

/** Newest-first caps; the response flags `capped` so the UI can say so. */
const HISTORY_VISIT_CAP = 50;
const HISTORY_RX_CAP = 100;
const HISTORY_ENTRY_CAP = 1000;
const HISTORY_NOTE_CAP = 200;

const clinicInclude = { model: Clinic, as: "clinic", attributes: ["id", "name", "city", "addressLine"] };
const doctorInclude = {
  model: DoctorProfile,
  as: "doctor",
  attributes: ["userId", "qualification"],
  include: [
    { model: User, as: "user", attributes: ["id", "name", "profilePhotoUrl"] },
    { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name"] },
  ],
};
const authorInclude = { model: User, as: "author", attributes: ["id", "name"] };

/** Doctor-note rows a doctor may see: published ones, and their own drafts. */
const visibleToDoctor = (doctorId) => ({
  [Op.or]: [{ kind: { [Op.ne]: K.DOCTOR_NOTE } }, { patientVisible: true }, { doctorId }],
});

const groupBy = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    const k = r[key] == null ? null : String(r[key]);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
};

const order = (...cols) => cols.map((c) => [c, "DESC"]);

/**
 * @param {string|number} patientId  already authorized by the caller
 * @param {{ scope?: object|null }} [opts]  null = the patient themself
 */
async function build(patientId, { scope = null } = {}) {
  const isDoctor = Boolean(scope);
  const me = scope?.doctorId;
  const can = (category) => !isDoctor || scope.has(category);

  // ── Which visits ───────────────────────────────────────────────────────────
  const bookingWhere = isDoctor
    ? {
        patientId,
        [Op.or]: [
          { status: BOOKING_STATUS.COMPLETED, ...access.bookingWhere(scope) },
          { doctorId: me, status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.NO_SHOW] } },
        ],
      }
    : { patientId, status: BOOKING_STATUS.COMPLETED };

  // ── Which entries / prescriptions / notes ──────────────────────────────────
  const entryWhere = { patientId, status: CLINICAL_ENTRY_STATUS.ACTIVE };
  if (isDoctor) entryWhere[Op.and] = [visibleToDoctor(me), access.entryWhere(scope)];
  else entryWhere.patientVisible = true;

  // A prescription is read for its medicines (medications) or for the
  // diagnosis written on it (diagnoses); each part is masked on its own below.
  let rxWhere = { patientId, supersededById: null, status: PRESCRIPTION_STATUS.FINALIZED };
  if (isDoctor) {
    const others = can(C.MEDICATIONS) || can(C.DIAGNOSES);
    rxWhere = others
      ? { patientId, supersededById: null, [Op.or]: [{ doctorId: me }, { status: PRESCRIPTION_STATUS.FINALIZED }] }
      : { patientId, supersededById: null, doctorId: me };
  }

  const noteWhere = isDoctor ? { patientId, ...access.clinicalNoteWhere(scope) } : { patientId };

  const [visits, entries, prescriptions, notes] = await Promise.all([
    Booking.findAll({
      where: bookingWhere,
      include: [clinicInclude, doctorInclude],
      order: order("slotDate", "slotStartTime", "id"),
      limit: HISTORY_VISIT_CAP,
    }),
    ClinicalEntry.findAll({
      where: entryWhere,
      include: [authorInclude, { model: Booking, as: "booking", attributes: ["id", "slotDate", "doctorId"] }],
      order: order("createdAt", "id"),
      limit: HISTORY_ENTRY_CAP,
    }),
    Prescription.findAll({
      where: rxWhere,
      include: [
        { model: PrescriptionItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] },
        { model: DoctorProfile, as: "doctor", attributes: ["userId"], include: [{ model: User, as: "user", attributes: ["id", "name"] }] },
        { model: Booking, as: "booking", attributes: ["id", "slotDate"] },
      ],
      order: order("createdAt", "id"),
      limit: HISTORY_RX_CAP,
    }),
    ClinicalNote.findAll({
      where: noteWhere,
      include: [authorInclude, { model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
      order: order("createdAt", "id"),
      limit: HISTORY_NOTE_CAP,
    }),
  ]);

  const visitIds = visits.map((v) => v.id);
  const [vitals, followUps] = visitIds.length
    ? await Promise.all([
        PatientVitals.findAll({
          where: { patientId, bookingId: { [Op.in]: visitIds } },
          include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
          order: order("recordedAt", "createdAt", "id"),
        }),
        PatientFollowUp.findAll({
          where: { bookingId: { [Op.in]: visitIds } },
          include: [
            { model: FollowUpStatus, as: "status" },
            { model: User, as: "doctor", attributes: ["id", "name"] },
          ],
        }),
      ])
    : [[], []];

  // ── Per-prescription masks ─────────────────────────────────────────────────
  const rxRows = prescriptions.map((rx) => {
    const own = isDoctor && scope.isOwn(rx.doctorId);
    return {
      rx,
      showItems: !isDoctor || own || scope.has(C.MEDICATIONS),
      showDiagnosis: !isDoctor || own || scope.has(C.DIAGNOSES),
      showComplaint: !isDoctor || own || scope.has(C.CONSULTATIONS),
    };
  });
  // The prescription of a visit = its current (non-superseded) version.
  const rxByVisit = new Map();
  for (const row of rxRows) {
    if (row.rx.bookingId == null) continue;
    const k = String(row.rx.bookingId);
    const prev = rxByVisit.get(k);
    if (!prev || Number(row.rx.version) > Number(prev.rx.version)) rxByVisit.set(k, row);
  }

  // A legacy consultation note also carries a diagnosis and history lines —
  // each shown only when its own category is visible.
  const noteRows = notes.map((note) => {
    const own = !isDoctor || scope.isOwn(note.doctorId);
    return {
      note,
      bookingId: note.bookingId,
      showDiagnosis: own || scope.has(C.DIAGNOSES),
      showHistory: own || scope.has(C.MEDICAL_HISTORY),
      // The note's treatment line is the medication plan.
      showTreatment: own || scope.has(C.MEDICATIONS),
    };
  });

  const entriesByVisit = groupBy(entries, "bookingId");
  const notesByVisit = groupBy(noteRows, "bookingId");
  const vitalsByVisit = groupBy(vitals, "bookingId");
  const followUpByVisit = new Map(followUps.map((f) => [String(f.bookingId), f]));
  const ofKind = (rows, kind) => rows.filter((e) => e.kind === kind);

  // ── Consultations, each on its own ─────────────────────────────────────────
  const consultations = visits.map((booking) => {
    const id = String(booking.id);
    const own = !isDoctor || scope.isOwn(booking.doctorId);
    const allowed = (category) => own || scope.has(category);
    const visitEntries = entriesByVisit.get(id) || [];
    const rxRow = rxByVisit.get(id) || null;
    const locked = isDoctor
      ? [C.DIAGNOSES, C.MEDICATIONS, C.INVESTIGATIONS, C.DOCTOR_NOTES].filter((c) => !allowed(c))
      : [];
    return {
      booking,
      isMine: isDoctor && own,
      complaints: ofKind(visitEntries, K.COMPLAINT),
      examinations: ofKind(visitEntries, K.EXAMINATION),
      diagnoses: allowed(C.DIAGNOSES) ? ofKind(visitEntries, K.DIAGNOSIS) : null,
      investigations: allowed(C.INVESTIGATIONS) ? ofKind(visitEntries, K.INVESTIGATION) : null,
      notes: allowed(C.DOCTOR_NOTES) ? ofKind(visitEntries, K.DOCTOR_NOTE) : null,
      legacyNotes: allowed(C.DOCTOR_NOTES) ? notesByVisit.get(id) || [] : null,
      prescription: allowed(C.MEDICATIONS) ? rxRow : null,
      // The diagnosis line written on a prescription, when diagnoses are visible
      // but the prescription itself is not.
      rxDiagnosis: !allowed(C.MEDICATIONS) && allowed(C.DIAGNOSES) ? rxRow?.rx.diagnosis ?? null : null,
      // The doctor's advice belongs to the consultation (common information);
      // sent on its own when the prescription itself is still locked.
      advice: !allowed(C.MEDICATIONS) && allowed(C.CONSULTATIONS) ? rxRow?.rx.advice ?? null : null,
      vitals: vitalsByVisit.get(id) || [],
      followUp: followUpByVisit.get(id) ?? null,
      locked,
    };
  });

  // ── Summary lists across the whole record ──────────────────────────────────
  const structuredDxVisits = new Set(
    ofKind(entries, K.DIAGNOSIS)
      .map((e) => (e.bookingId != null ? String(e.bookingId) : null))
      .filter(Boolean)
  );
  // Older prescriptions carry a free-text diagnosis and no structured entry —
  // list it too (once per visit), labelled as coming from the prescription.
  const rxDiagnoses = rxRows.filter(
    (r) =>
      r.showDiagnosis &&
      r.rx.status === PRESCRIPTION_STATUS.FINALIZED &&
      r.rx.diagnosis &&
      !(r.rx.bookingId != null && structuredDxVisits.has(String(r.rx.bookingId)))
  );

  return {
    consultations,
    medicalHistory: ofKind(entries, K.HISTORY),
    longTermConditions: ofKind(entries, K.COMORBIDITY),
    diagnoses: ofKind(entries, K.DIAGNOSIS),
    rxDiagnoses,
    prescriptions: rxRows.filter((r) => r.showItems),
    investigations: ofKind(entries, K.INVESTIGATION),
    doctorNotes: ofKind(entries, K.DOCTOR_NOTE),
    legacyNotes: noteRows,
    lockedCategories: isDoctor ? access.lockedOf(scope) : [],
    capped: {
      consultations: visits.length >= HISTORY_VISIT_CAP,
      prescriptions: prescriptions.length >= HISTORY_RX_CAP,
    },
  };
}

module.exports = { build, HISTORY_VISIT_CAP, HISTORY_RX_CAP };
