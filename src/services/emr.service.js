/**
 * Doctor EMR workspace (migration 051) — the workbench, the patient medical
 * workspace and the structured consultation record.
 *
 * Built ON the existing model, not beside it:
 *   - the visit/encounter IS the booking (no new encounter table, no OPD/IPD);
 *   - vitals are patient_vitals, prescriptions are prescriptions, follow-ups
 *     are patient_follow_ups (+ the existing reminder scheduler);
 *   - only the structured entries (complaint, history, comorbidity,
 *     examination, diagnosis, investigation order, doctor's note) are new, in
 *     clinical_entries.
 *
 * Access rules (server-side, every call):
 *   READ  — the doctor must TREAT the patient: a confirmed or completed booking
 *           between them (TREATED_BOOKING_STATUSES — the same gate as My
 *           Patients and the patient timeline). On top of that (migration 057)
 *           the doctor reads their OWN records plus only those categories of
 *           other doctors' records the patient has granted them
 *           (clinicalAccess.service — filtered in the query, never sent).
 *   WRITE — through a booking the doctor owns that is confirmed/completed
 *           (patientVitals.gateBookingPatient — the same gate as the existing
 *           booking-scoped notes and vitals).
 *   A doctor's UNPUBLISHED note is visible only to its author. Entries are
 *   never deleted; the author retires a wrong one with a reason.
 */
const { Op, fn, col, literal } = require("sequelize");
const {
  sequelize,
  Booking,
  User,
  PatientProfile,
  Allergy,
  Condition,
  PatientCurrentMedication,
  PatientVitals,
  ClinicalEntry,
  ClinicalNote,
  Prescription,
  PrescriptionItem,
  PatientFollowUp,
  FollowUpStatus,
  Clinic,
  DoctorProfile,
  Specialization,
  DiagnosticTest,
  Medicine,
  MedicineMaster,
  AccessAuditLog,
  UploadedRecord,
  DoctorAccessRequest,
  DoctorAccessGrantItem,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const { istToday } = require("../utils/period");
const { ageFrom } = require("../utils/age");
const { gateBookingPatient } = require("./patientVitals.service");
const access = require("./clinicalAccess.service");
const medicalHistory = require("./medicalHistory.service");
const icd = require("./icdCode.service");
const {
  BOOKING_STATUS,
  TREATED_BOOKING_STATUSES,
  PRESCRIPTION_STATUS,
  CLINICAL_ENTRY_KIND,
  CLINICAL_ENTRY_STATUS,
  CLINICAL_ENTRY_EDIT_HOURS,
  CLINICAL_ENTRY_DEFAULT_VISIBLE,
  WORKBENCH_LIST_CAP,
  WORKBENCH_UPCOMING_CAP,
  TIMELINE_ROSTER_CAP,
  EMR_AUDIT_ACTIONS,
  ACCESS_AUDIT_ACTIONS,
  ACCESS_REQUEST_STATUS,
  DOCUMENT_ACCESS_CATEGORIES,
  CLINICAL_ACCESS_CATEGORY: CAT,
} = require("../config/constants");

const PENDING_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED];
const COMPLETED_STATUSES = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW];
const DAY_STATUSES = [...PENDING_STATUSES, ...COMPLETED_STATUSES]; // every non-cancelled visit

// ── Shared includes ──────────────────────────────────────────────────────────
const patientInclude = (where) => ({
  model: User,
  as: "patient",
  attributes: ["id", "name", "phone", "profilePhotoUrl", "createdAt"],
  ...(where ? { where, required: true } : {}),
  include: [{ model: PatientProfile, as: "patientProfile", attributes: ["dateOfBirth", "gender"] }],
});
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

// ── Search ── shared with My Patients (utils/patientRegNo) ───────────────────
const { parseSearch, searchWhere } = require("../utils/patientRegNo");

// ── Audit ────────────────────────────────────────────────────────────────────
function audit(ctx, action, { patientId, entityType = null, entityId = null, details = null }, transaction) {
  return AccessAuditLog.create(
    {
      actorUserId: ctx?.userId ?? null,
      actorRole: ctx?.role ?? null,
      ip: ctx?.ip ? String(ctx.ip).slice(0, 64) : null,
      action,
      doctorId: ctx?.userId ?? null,
      patientId,
      entityType,
      entityId,
      details,
    },
    { transaction }
  );
}

// ── Access ───────────────────────────────────────────────────────────────────
/** READ gate: a confirmed/completed booking between this doctor and patient. */
const assertTreats = access.assertTreats;

/** The relationship gate + this doctor's consent scope over the patient (re-read every call). */
async function readScope(doctorId, patientId) {
  await assertTreats(doctorId, patientId);
  return access.scopeFor(doctorId, patientId);
}

/** Which doctor-note rows a doctor may see: published ones, and their own drafts. */
const visibleToDoctor = (doctorId) => ({
  [Op.or]: [
    { kind: { [Op.ne]: CLINICAL_ENTRY_KIND.DOCTOR_NOTE } },
    { patientVisible: true },
    { doctorId },
  ],
});

// ── Workbench ────────────────────────────────────────────────────────────────
/**
 * The doctor's working day, all from real bookings:
 *   consultations — the selected date's visits, PENDING (not yet completed) or
 *                   COMPLETED (completed / no-show) per the toggle;
 *   today         — every non-cancelled visit on the selected date;
 *   upcoming      — confirmed / awaiting-payment visits after the selected date;
 *   previous      — patients this doctor has completed a consultation with;
 *   all           — every patient with a confirmed/completed booking with them.
 * In-clinic vs video is the appointment TYPE only.
 */
async function workbench(doctorId, { date, view = "pending", q } = {}) {
  const day = date || istToday();
  const search = parseSearch(q);
  const bookingSearch = searchWhere(search, { bookingLevel: true });
  const withSearch = (where) => (bookingSearch ? { [Op.and]: [where, bookingSearch] } : where);
  const listInclude = [patientInclude(), clinicInclude];

  const [dayRows, upcomingRows, previous, all] = await Promise.all([
    Booking.findAll({
      where: withSearch({ doctorId, slotDate: day, status: { [Op.in]: DAY_STATUSES } }),
      include: listInclude,
      order: [
        ["slotStartTime", "ASC"],
        ["queueNumber", "ASC"],
        ["id", "ASC"],
      ],
      limit: WORKBENCH_LIST_CAP,
    }),
    Booking.findAll({
      where: withSearch({ doctorId, slotDate: { [Op.gt]: day }, status: { [Op.in]: PENDING_STATUSES } }),
      include: listInclude,
      order: [
        ["slotDate", "ASC"],
        ["slotStartTime", "ASC"],
        ["id", "ASC"],
      ],
      limit: WORKBENCH_UPCOMING_CAP,
    }),
    roster(doctorId, { statuses: [BOOKING_STATUS.COMPLETED], search }),
    roster(doctorId, { statuses: TREATED_BOOKING_STATUSES, search }),
  ]);

  const wanted = view === "completed" ? COMPLETED_STATUSES : PENDING_STATUSES;
  const consultations = dayRows.filter((b) => wanted.includes(b.status));
  const counts = {
    pending: dayRows.filter((b) => PENDING_STATUSES.includes(b.status)).length,
    completed: dayRows.filter((b) => COMPLETED_STATUSES.includes(b.status)).length,
  };

  return {
    date: day,
    view,
    counts,
    consultations,
    today: dayRows,
    upcoming: { rows: upcomingRows, capped: upcomingRows.length >= WORKBENCH_UPCOMING_CAP },
    previous,
    all,
  };
}

/**
 * Distinct patients over this doctor's bookings in `statuses` — one aggregate
 * query + one profile query (never one per patient).
 */
async function roster(doctorId, { statuses, search }) {
  const where = { doctorId, status: { [Op.in]: statuses } };
  const patientSearch = searchWhere(search);
  const rows = await Booking.findAll({
    where: patientSearch ? { [Op.and]: [where, patientSearch] } : where,
    attributes: [
      "patientId",
      [fn("COUNT", col("Booking.id")), "visitCount"],
      [fn("MAX", col("slot_date")), "lastVisitOn"],
      [fn("MAX", col("Booking.id")), "lastBookingId"],
    ],
    include: [
      {
        model: User,
        as: "patient",
        attributes: ["id", "name", "phone", "profilePhotoUrl"],
        required: true,
      },
    ],
    group: ["Booking.patient_id", "patient.id"],
    order: [[literal("lastVisitOn"), "DESC"]],
    limit: TIMELINE_ROSTER_CAP,
    subQuery: false,
  });
  const ids = rows.map((r) => r.patientId);
  const profiles = ids.length
    ? await PatientProfile.findAll({
        where: { userId: { [Op.in]: ids } },
        attributes: ["userId", "dateOfBirth", "gender"],
      })
    : [];
  const byId = new Map(profiles.map((p) => [String(p.userId), p]));
  return {
    rows: rows.map((r) => ({ row: r, profile: byId.get(String(r.patientId)) ?? null })),
    capped: rows.length >= TIMELINE_ROSTER_CAP,
  };
}

// ── Patient workspace header ─────────────────────────────────────────────────
/**
 * The newest NON-NULL value of each vital with the time it was measured. A
 * field never recorded is absent (null) — never a fabricated value.
 */
const LATEST_KEYS = [
  "bloodPressure",
  "bpSystolic",
  "bpDiastolic",
  "pulseRateBpm",
  "heartRateBpm",
  "respiratoryRate",
  "spo2Percent",
  "temperatureF",
  "heightCm",
  "weightKg",
  "waistCm",
  "hipCm",
  "headCircumferenceCm",
];

/** Which visit the workspace is "on": the asked-for one, else today's, else the latest. */
async function resolveEncounter(doctorId, patientId, bookingId) {
  const base = { doctorId, patientId, status: { [Op.in]: DAY_STATUSES } };
  const include = [clinicInclude];
  if (bookingId) {
    const b = await Booking.findOne({ where: { ...base, id: bookingId }, include });
    if (!b) throw ApiError.notFound("Appointment not found");
    return b;
  }
  const today = istToday();
  return (
    (await Booking.findOne({
      where: { ...base, slotDate: today },
      include,
      order: [["slotStartTime", "ASC"]],
    })) ||
    (await Booking.findOne({
      where: { ...base, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
      include,
      order: [
        ["slotDate", "DESC"],
        ["slotStartTime", "DESC"],
        ["id", "DESC"],
      ],
    }))
  );
}

async function patientWorkspace(doctorId, patientId, { bookingId } = {}, ctx) {
  const scope = await readScope(doctorId, patientId);
  const vitalsScope = await access.vitalsWhere(scope);

  const [user, encounter, vitals, visits, accessSummary] = await Promise.all([
    User.findByPk(patientId, {
      attributes: ["id", "name", "email", "phone", "profilePhotoUrl", "createdAt"],
      include: [
        {
          model: PatientProfile,
          as: "patientProfile",
          include: [
            { model: Allergy, as: "allergies", through: { attributes: ["severity"] } },
            { model: Condition, as: "conditions", through: { attributes: ["diagnosedYear"] } },
            { model: PatientCurrentMedication, as: "medications" },
          ],
        },
      ],
    }),
    resolveEncounter(doctorId, patientId, bookingId),
    PatientVitals.findAll({
      where: { patientId, [Op.and]: [vitalsScope] },
      order: [
        ["recordedOn", "DESC"],
        ["recordedAt", "DESC"],
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: 60,
    }),
    visitList(patientId, scope),
    access.accessSummary(doctorId, patientId),
  ]);
  if (!user) throw ApiError.notFound("Patient not found");

  await audit(ctx, EMR_AUDIT_ACTIONS.VIEW, {
    patientId,
    entityType: "patient",
    entityId: patientId,
    details: { grantedCategories: [...scope.granted] },
  });

  return {
    user,
    encounter,
    latestVitalRows: vitals,
    visits,
    access: accessSummary,
    age: ageFrom(user.patientProfile?.dateOfBirth),
  };
}

/**
 * The patient's visits for "Previous visit summary": this doctor's own
 * completed / confirmed / no-show visits, plus other doctors' COMPLETED
 * consultations only when the patient has granted `consultations`.
 */
function visitList(patientId, scope) {
  const doctorId = scope.doctorId;
  return Booking.findAll({
    where: {
      patientId,
      [Op.or]: [
        { status: BOOKING_STATUS.COMPLETED, ...access.bookingWhere(scope) },
        { doctorId, status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.NO_SHOW] } },
      ],
    },
    include: [clinicInclude, doctorInclude],
    order: [
      ["slotDate", "DESC"],
      ["slotStartTime", "DESC"],
      ["id", "DESC"],
    ],
    limit: 200,
  });
}

// ── Vitals ───────────────────────────────────────────────────────────────────
async function ageOf(patientId) {
  const profile = await PatientProfile.findByPk(patientId, { attributes: ["dateOfBirth"] });
  return ageFrom(profile?.dateOfBirth);
}

async function vitalsHistory(doctorId, patientId, { from, to } = {}) {
  const scope = await readScope(doctorId, patientId);
  const scoped = await access.vitalsWhere(scope);
  const [rows, age] = await Promise.all([vitalRows(patientId, { from, to, scoped }), ageOf(patientId)]);
  return { rows, age };
}

/** `scoped` = the doctor's consent filter (clinicalAccess.vitalsWhere); absent for the patient. */
function vitalRows(patientId, { from, to, scoped } = {}) {
  const where = { patientId };
  if (scoped) where[Op.and] = [scoped];
  if (from || to) {
    where.recordedOn = {};
    if (from) where.recordedOn[Op.gte] = from;
    if (to) where.recordedOn[Op.lte] = to;
  }
  return PatientVitals.findAll({
    where,
    include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
    order: [
      ["recordedOn", "DESC"],
      ["recordedAt", "DESC"],
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: 1000,
  });
}

async function addVitals(doctorId, bookingId, body, ctx) {
  const vitalsService = require("./patientVitals.service");
  const { patientId, id } = await vitalsService.addEmrReading(doctorId, bookingId, body);
  await audit(ctx, EMR_AUDIT_ACTIONS.VITALS_ADDED, { patientId, entityType: "patient_vitals", entityId: id });
  // The refreshed table follows the same consent scope as every other read.
  const scoped = await access.vitalsWhere(await access.scopeFor(doctorId, patientId));
  const [rows, age] = await Promise.all([vitalRows(patientId, { scoped }), ageOf(patientId)]);
  return { patientId, rows, age };
}

// ── Structured entries ───────────────────────────────────────────────────────
async function listEntries(doctorId, patientId, { kind, bookingId, includeRetired } = {}) {
  const scope = await readScope(doctorId, patientId);
  const where = { patientId, [Op.and]: [visibleToDoctor(doctorId), access.entryWhere(scope)] };
  if (kind) where.kind = kind;
  if (bookingId) where.bookingId = bookingId;
  if (!includeRetired) where.status = CLINICAL_ENTRY_STATUS.ACTIVE;
  return ClinicalEntry.findAll({
    where,
    include: [authorInclude, { model: Booking, as: "booking", attributes: ["id", "slotDate"] }],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: 1000,
  });
}

async function createEntry(doctorId, bookingId, body, ctx) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  const entry = await sequelize.transaction(async (transaction) => {
    // A diagnosis picked from the admin ICD catalogue (migration 059): the
    // code, system, version and description come from that row, never the client.
    const coded =
      body.kind === CLINICAL_ENTRY_KIND.DIAGNOSIS && body.icdCodeId
        ? await icd.snapshotFor(body.icdCodeId, transaction)
        : null;
    const row = await ClinicalEntry.create(
      {
        patientId: booking.patientId,
        doctorId,
        bookingId: booking.id,
        kind: body.kind,
        category: body.category ?? null,
        title: body.title ?? null,
        code: coded ? coded.code : body.code ? icd.normCode(body.code) : null,
        icdCodeId: coded?.icdCodeId ?? null,
        codeSystem: coded?.codeSystem ?? null,
        codeVersion: coded?.codeVersion ?? null,
        codeDescription: coded?.codeDescription ?? null,
        details: body.details ?? null,
        remarks: body.remarks ?? null,
        recordedOn: body.recordedOn ?? istToday(),
        patientVisible: body.patientVisible ?? CLINICAL_ENTRY_DEFAULT_VISIBLE[body.kind] ?? true,
        createdBy: doctorId,
        updatedBy: doctorId,
      },
      { transaction }
    );
    await audit(
      ctx,
      EMR_AUDIT_ACTIONS.ENTRY_CREATED,
      { patientId: booking.patientId, entityType: `clinical_entry:${body.kind}`, entityId: row.id },
      transaction
    );
    return row;
  });
  return ClinicalEntry.findByPk(entry.id, { include: [authorInclude] });
}

async function findOwnEntry(doctorId, id) {
  const entry = await ClinicalEntry.findByPk(id);
  // Someone else's entry is a 404, not a 403: never confirm it exists.
  if (!entry || !sameId(entry.doctorId, doctorId)) throw ApiError.notFound("Entry not found");
  if (entry.status !== CLINICAL_ENTRY_STATUS.ACTIVE) {
    throw ApiError.conflict("This entry was marked as entered in error and can no longer change");
  }
  return entry;
}

const isPublishedNote = (e) => e.kind === CLINICAL_ENTRY_KIND.DOCTOR_NOTE && e.patientVisible;
const withinEditWindow = (e) =>
  Date.now() - new Date(e.createdAt).getTime() <= CLINICAL_ENTRY_EDIT_HOURS * 3600 * 1000;

/** Whether the author can still correct the entry in place (the UI shows the same). */
function canEditEntry(e, doctorId) {
  return (
    sameId(e.doctorId, doctorId) &&
    e.status === CLINICAL_ENTRY_STATUS.ACTIVE &&
    !isPublishedNote(e) &&
    withinEditWindow(e)
  );
}

/**
 * Correct an entry in place — only its author, only within the edit window,
 * and never a PUBLISHED note (the patient may already have read it; a final
 * clinical note is never silently rewritten). Publishing a draft note is a
 * one-way step: a published note cannot be un-published.
 */
async function updateEntry(doctorId, id, patch, ctx) {
  const entry = await findOwnEntry(doctorId, id);
  const publishingOnly = Object.keys(patch).length === 1 && patch.patientVisible === true;

  if (isPublishedNote(entry)) {
    throw ApiError.conflict("A published note is final. Mark it as entered in error and add a new note instead.");
  }
  if (!publishingOnly && !withinEditWindow(entry)) {
    throw ApiError.conflict(
      `Entries can be corrected for ${CLINICAL_ENTRY_EDIT_HOURS} hours. Mark it as entered in error and add a new one instead.`
    );
  }

  const before = entry.get({ plain: true });
  const values = { ...patch };
  if (values.code !== undefined) {
    values.code = values.code ? icd.normCode(values.code) : null;
    // A hand-corrected code no longer matches the catalogue row it was picked
    // from — drop the link and its snapshot rather than keep a false one.
    if (entry.icdCodeId && values.code !== entry.code) {
      Object.assign(values, { icdCodeId: null, codeSystem: null, codeVersion: null, codeDescription: null });
    }
  }
  await sequelize.transaction(async (transaction) => {
    await entry.update({ ...values, updatedBy: doctorId }, { transaction });
    await audit(
      ctx,
      publishingOnly ? EMR_AUDIT_ACTIONS.NOTE_PUBLISHED : EMR_AUDIT_ACTIONS.ENTRY_UPDATED,
      {
        patientId: entry.patientId,
        entityType: `clinical_entry:${entry.kind}`,
        entityId: entry.id,
        // The previous values, so a correction never erases what was written.
        details: { before: pick(before, Object.keys(values)) },
      },
      transaction
    );
  });
  return ClinicalEntry.findByPk(entry.id, { include: [authorInclude] });
}

async function retireEntry(doctorId, id, reason, ctx) {
  const entry = await findOwnEntry(doctorId, id);
  await sequelize.transaction(async (transaction) => {
    await entry.update(
      { status: CLINICAL_ENTRY_STATUS.ENTERED_IN_ERROR, retiredReason: reason, updatedBy: doctorId },
      { transaction }
    );
    await audit(
      ctx,
      EMR_AUDIT_ACTIONS.ENTRY_RETIRED,
      { patientId: entry.patientId, entityType: `clinical_entry:${entry.kind}`, entityId: entry.id, details: { reason } },
      transaction
    );
  });
  return ClinicalEntry.findByPk(entry.id, { include: [authorInclude] });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] ?? null;
  return out;
}

// ── Visit summary ────────────────────────────────────────────────────────────
/**
 * Everything recorded in ONE visit, as it was recorded: the booking, the
 * vitals taken in it, its prescription, structured entries, legacy clinical
 * notes and follow-up. `viewer` decides visibility:
 *   doctor  — published entries + their own drafts; latest prescription
 *             version (a draft only when it is their own visit);
 *   patient — patient-visible entries only; finalized prescriptions only.
 */
async function visitArtifacts(booking, viewer, scope = null) {
  const isDoctor = viewer.role === "doctor";
  const ownVisit = isDoctor && sameId(booking.doctorId, viewer.id);
  // Another doctor's visit: each part needs its own category (migration 057).
  const allowed = (category) => !isDoctor || ownVisit || Boolean(scope?.has(category));
  const locked = isDoctor
    ? [CAT.DIAGNOSES, CAT.MEDICATIONS, CAT.INVESTIGATIONS, CAT.DOCTOR_NOTES].filter((c) => !allowed(c))
    : [];

  const entryWhere = { bookingId: booking.id, status: CLINICAL_ENTRY_STATUS.ACTIVE };
  if (isDoctor) entryWhere[Op.and] = [visibleToDoctor(viewer.id), ...(scope ? [access.entryWhere(scope)] : [])];
  else entryWhere.patientVisible = true;

  const rxWhere = { bookingId: booking.id, supersededById: null };
  if (!ownVisit) rxWhere.status = PRESCRIPTION_STATUS.FINALIZED;

  // Same-day readings not linked to the visit (home / clinic) are vitals
  // history — a doctor sees them only with the `vitals` grant.
  const sameDayUnlinked = !isDoctor || Boolean(scope?.has(CAT.VITALS));
  const vitalsWhere = sameDayUnlinked
    ? {
        patientId: booking.patientId,
        [Op.or]: [{ bookingId: booking.id }, { bookingId: null, recordedOn: booking.slotDate }],
      }
    : { patientId: booking.patientId, bookingId: booking.id };

  const [vitals, prescription, entries, notes, followUp] = await Promise.all([
    PatientVitals.findAll({
      where: vitalsWhere,
      include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
      order: [
        ["recordedAt", "DESC"],
        ["createdAt", "DESC"],
      ],
    }),
    allowed(CAT.MEDICATIONS) || allowed(CAT.DIAGNOSES)
      ? Prescription.findOne({
          where: rxWhere,
          include: [{ model: PrescriptionItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] }],
          order: [["version", "DESC"]],
        })
      : null,
    ClinicalEntry.findAll({ where: entryWhere, include: [authorInclude], order: [["createdAt", "ASC"]] }),
    !allowed(CAT.DOCTOR_NOTES)
      ? []
      : isDoctor
        ? ClinicalNote.findAll({ where: { bookingId: booking.id }, order: [["createdAt", "DESC"]] })
        : ClinicalNote.findAll({ where: { bookingId: booking.id, patientId: viewer.id }, order: [["createdAt", "DESC"]] }),
    PatientFollowUp.findOne({ where: { bookingId: booking.id }, include: [{ model: FollowUpStatus, as: "status" }] }),
  ]);

  const rx = prescription;
  if (rx && !allowed(CAT.MEDICATIONS)) {
    // Medicines stay private: drop the items and the prescription's own notes.
    // The diagnosis line and the doctor's advice are common consultation
    // information (IHS policy 2026-11-03). An include lives on the instance AND
    // in dataValues — clear both.
    rx.items = [];
    rx.setDataValue("items", []);
    rx.setDataValue("notes", null);
  }
  if (rx && !allowed(CAT.DIAGNOSES)) rx.setDataValue("diagnosis", null);
  for (const n of notes) {
    if (!allowed(CAT.DIAGNOSES)) n.setDataValue("diagnosis", null);
    if (!allowed(CAT.MEDICAL_HISTORY)) {
      n.setDataValue("historyMedical", null);
      n.setDataValue("historySurgical", null);
    }
    if (!allowed(CAT.MEDICATIONS)) n.setDataValue("treatment", null);
  }
  return { booking, vitals, prescription: rx, entries, notes, followUp, locked, age: await ageOf(booking.patientId) };
}

/**
 * One visit for a doctor: their own visit in full; another doctor's COMPLETED
 * visit only with the `consultations` grant, and within it each part
 * (diagnosis, prescription, tests, notes) only with its own grant.
 */
async function visitSummaryForDoctor(doctorId, patientId, bookingId) {
  const scope = await readScope(doctorId, patientId);
  const booking = await Booking.findOne({
    where: {
      id: bookingId,
      patientId,
      [Op.or]: [
        { status: BOOKING_STATUS.COMPLETED, ...access.bookingWhere(scope) },
        { doctorId, status: { [Op.in]: DAY_STATUSES } },
      ],
    },
    include: [clinicInclude, doctorInclude],
  });
  // 404, not 403: never confirm that a locked visit exists.
  if (!booking) throw ApiError.notFound("Visit not found");
  return visitArtifacts(booking, { role: "doctor", id: doctorId }, scope);
}

// ── Structured history (migration 057) ───────────────────────────────────────
/**
 * The patient's whole clinical history for the workbench — the same builder
 * the patient's own record uses — limited to this doctor's own records plus
 * the categories the patient granted. Comes with the consent summary.
 */
async function historyForDoctor(doctorId, patientId, ctx) {
  const scope = await readScope(doctorId, patientId);
  const [history, summary, age] = await Promise.all([
    medicalHistory.build(patientId, { scope }),
    access.accessSummary(doctorId, patientId),
    ageOf(patientId),
  ]);
  await audit(ctx, ACCESS_AUDIT_ACTIONS.HISTORY_VIEWED, {
    patientId,
    entityType: "patient",
    entityId: patientId,
    details: { grantedCategories: [...scope.granted] },
  });
  return { history, access: summary, age };
}

/**
 * The patient's documents (uploaded_records) this doctor may see, for the
 * workbench. Same gate as every other doctor read: a TREATING doctor only
 * (readScope → assertTreats), then per document:
 *   • one this doctor filed themselves                         → via "own"
 *   • its consent category granted by the patient (057)        → via "category"
 *     (prescriptions → medications, everything else → investigations)
 *   • shared one-by-one through a document request (045)       → via "document"
 *     — stream-only: no file link, read through the audited endpoint.
 * Identity documents are excluded by the `clinical` scope AND recordAllowed.
 * Nothing about locked documents is returned, not even that they exist.
 */
async function documentsForDoctor(doctorId, patientId, ctx) {
  const scope = await readScope(doctorId, patientId);
  const [rows, grants, profile] = await Promise.all([
    UploadedRecord.scope("clinical").findAll({
      where: { patientId },
      include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
      order: [
        ["uploadedAt", "DESC"],
        ["id", "DESC"],
      ],
    }),
    DoctorAccessRequest.findAll({
      where: {
        doctorId,
        patientId,
        status: ACCESS_REQUEST_STATUS.APPROVED,
        grantExpiresAt: { [Op.gt]: new Date() },
        category: { [Op.in]: DOCUMENT_ACCESS_CATEGORIES },
      },
      attributes: ["id", "grantExpiresAt"],
      include: [{ model: DoctorAccessGrantItem, as: "items", attributes: ["recordId"] }],
    }),
    DoctorProfile.findByPk(doctorId, { attributes: ["verificationStatus"], raw: true }),
  ]);
  // A doctor whose verification was withdrawn loses document-level grants too.
  const shared = new Map();
  if (profile?.verificationStatus === "approved") {
    for (const g of grants) {
      for (const it of g.items || []) shared.set(String(it.recordId), { requestId: String(g.id), until: g.grantExpiresAt });
    }
  }
  const documents = [];
  for (const row of rows) {
    if (access.recordAllowed(scope, row)) {
      const own = scope.isOwn(row.recordedByUserId);
      documents.push({
        row,
        streamOnly: false,
        access: own ? { via: "own" } : { via: "category", category: access.FILE_TYPE_CATEGORY[row.fileType] ?? "investigations" },
      });
    } else if (shared.has(String(row.id))) {
      const g = shared.get(String(row.id));
      documents.push({ row, streamOnly: true, access: { via: "document", requestId: g.requestId, until: g.until } });
    }
  }
  await audit(ctx, ACCESS_AUDIT_ACTIONS.HISTORY_VIEWED, {
    patientId,
    entityType: "patient_documents",
    entityId: patientId,
    details: { documents: documents.length, grantedCategories: [...scope.granted] },
  });
  return documents;
}

/** The patient's own structured history (no consent filter — it is theirs). */
async function historyForPatient(patientId) {
  const [history, age] = await Promise.all([medicalHistory.build(patientId), ageOf(patientId)]);
  return { history, age };
}

async function visitSummaryForPatient(patientId, bookingId) {
  const booking = await Booking.findOne({
    where: { id: bookingId, patientId, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
    include: [clinicInclude, doctorInclude],
  });
  if (!booking) throw ApiError.notFound("Visit not found");
  return visitArtifacts(booking, { role: "patient", id: patientId });
}

// ── Catalogues (real data only) ──────────────────────────────────────────────
const likeOf = (q) => `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Tests the platform's diagnostic labs actually offer, grouped by name. */
function searchInvestigations(q) {
  return DiagnosticTest.findAll({
    where: { isActive: true, name: { [Op.like]: likeOf(q) } },
    attributes: [
      "name",
      [fn("MIN", col("id")), "id"],
      [fn("COUNT", fn("DISTINCT", col("lab_id"))), "labCount"],
      [fn("MIN", col("price")), "minPrice"],
    ],
    group: ["name"],
    order: [["name", "ASC"]],
    limit: 20,
    raw: true,
  });
}

/**
 * Medicine search for the prescription picker: the doctor's own list
 * (favourites) first, then the SHARED IHS catalogue — every medicine any
 * doctor or pharmacy has added (medicine_masters), so a medicine one doctor
 * adds is found by every other doctor. Every word typed must match the name,
 * generic name / composition, strength, dosage form or manufacturer
 * ("para 500" → Paracetamol 500 mg), case-insensitively (the columns use a
 * case-insensitive collation). Capped at 6 words. Catalogue presence says
 * nothing about pharmacy stock.
 */
async function searchMedicines(doctorId, q) {
  const words = String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const allWords = (fields) => ({
    [Op.and]: words.map((w) => ({ [Op.or]: fields.map((f) => ({ [f]: { [Op.like]: likeOf(w) } })) })),
  });
  const [mine, catalogue] = await Promise.all([
    Medicine.findAll({
      where: { doctorId, isActive: true, ...allWords(["name", "genericName", "strength", "dosageForm", "manufacturer"]) },
      order: [["name", "ASC"]],
      limit: 15,
    }),
    MedicineMaster.findAll({
      where: { isActive: true, ...allWords(["medicineName", "genericName", "strength", "medicineType", "manufacturer"]) },
      attributes: ["id", "medicineName", "genericName", "medicineType", "strength", "manufacturer"],
      order: [["medicineName", "ASC"]],
      limit: 20,
    }),
  ]);
  return { mine, catalogue };
}

/** Diagnoses this doctor has recorded before — real suggestions, not a fake ICD list. */
function diagnosisSuggestions(doctorId, q) {
  return ClinicalEntry.findAll({
    where: {
      doctorId,
      kind: CLINICAL_ENTRY_KIND.DIAGNOSIS,
      status: CLINICAL_ENTRY_STATUS.ACTIVE,
      [Op.or]: [{ title: { [Op.like]: likeOf(q) } }, { code: { [Op.like]: likeOf(q) } }],
    },
    attributes: ["title", "code", "icdCodeId", "codeSystem", "codeVersion", [fn("COUNT", col("id")), "uses"]],
    group: ["title", "code", "icdCodeId", "codeSystem", "codeVersion"],
    order: [[literal("uses"), "DESC"]],
    limit: 15,
    raw: true,
  });
}

// ── Patient's own medical profile ────────────────────────────────────────────
async function medicalProfileForPatient(patientId) {
  const [user, vitals, entries, visits, followUps] = await Promise.all([
    User.findByPk(patientId, {
      attributes: ["id", "name", "email", "phone", "profilePhotoUrl", "createdAt"],
      include: [
        {
          model: PatientProfile,
          as: "patientProfile",
          include: [
            { model: Allergy, as: "allergies", through: { attributes: ["severity"] } },
            { model: Condition, as: "conditions", through: { attributes: ["diagnosedYear"] } },
            { model: PatientCurrentMedication, as: "medications" },
          ],
        },
      ],
    }),
    vitalRows(patientId),
    ClinicalEntry.findAll({
      where: { patientId, patientVisible: true, status: CLINICAL_ENTRY_STATUS.ACTIVE },
      include: [authorInclude, { model: Booking, as: "booking", attributes: ["id", "slotDate"] }],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: 1000,
    }),
    Booking.findAll({
      where: { patientId, status: BOOKING_STATUS.COMPLETED },
      include: [clinicInclude, doctorInclude],
      order: [
        ["slotDate", "DESC"],
        ["slotStartTime", "DESC"],
        ["id", "DESC"],
      ],
      limit: 200,
    }),
    PatientFollowUp.findAll({
      where: { patientId, followUpOn: { [Op.ne]: null } },
      include: [{ model: User, as: "doctor", attributes: ["id", "name"] }],
      order: [["followUpOn", "DESC"]],
      limit: 50,
    }),
  ]);
  if (!user) throw ApiError.notFound("Patient not found");
  return { user, vitals, entries, visits, followUps, age: ageFrom(user.patientProfile?.dateOfBirth) };
}

/**
 * Read-only audit trail of THIS doctor's own actions on one patient (the
 * append-only access_audit_logs). The relationship gate applies; other
 * doctors'/staff actions and the client IP are never returned. `details` is
 * passed through only for keys the application itself writes.
 */
const AUDIT_DETAIL_KEYS = ["before", "reason", "grantedCategories", "documents"];
async function auditForDoctor(doctorId, patientId, q) {
  await assertTreats(doctorId, patientId);
  const where = { patientId, actorUserId: doctorId };
  if (q.action) where.action = q.action;
  if (q.entityType) where.entityType = { [Op.like]: `${q.entityType}%` };
  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt[Op.gte] = new Date(`${q.from}T00:00:00+05:30`);
    if (q.to) where.createdAt[Op.lte] = new Date(`${q.to}T23:59:59.999+05:30`);
  }
  const base = { patientId, actorUserId: doctorId };
  const [{ rows, count }, actions, entities] = await Promise.all([
    AccessAuditLog.findAndCountAll({
      where,
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: q.limit,
      offset: (q.page - 1) * q.limit,
      attributes: ["id", "action", "actorRole", "entityType", "entityId", "details", "createdAt"],
    }),
    AccessAuditLog.findAll({ where: base, attributes: [[fn("DISTINCT", col("action")), "action"]], raw: true }),
    AccessAuditLog.findAll({ where: base, attributes: [[fn("DISTINCT", col("entity_type")), "entityType"]], raw: true }),
  ]);
  const pick = (d) => {
    if (!d || typeof d !== "object") return null;
    const out = {};
    for (const k of AUDIT_DETAIL_KEYS) if (d[k] !== undefined) out[k] = d[k];
    return Object.keys(out).length ? out : null;
  };
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      at: r.createdAt,
      action: r.action,
      role: r.actorRole,
      entityType: r.entityType,
      entityId: r.entityId == null ? null : String(r.entityId),
      details: pick(r.details),
    })),
    total: count,
    page: q.page,
    limit: q.limit,
    totalPages: Math.max(1, Math.ceil(count / q.limit)),
    actions: actions.map((a) => a.action).filter(Boolean).sort(),
    entityTypes: [...new Set(entities.map((e) => (e.entityType || "").split(":")[0]).filter(Boolean))].sort(),
  };
}

module.exports = {
  auditForDoctor,
  canEditEntry,
  workbench,
  patientWorkspace,
  vitalsHistory,
  addVitals,
  listEntries,
  createEntry,
  updateEntry,
  retireEntry,
  visitSummaryForDoctor,
  visitSummaryForPatient,
  historyForDoctor,
  documentsForDoctor,
  historyForPatient,
  searchInvestigations,
  searchMedicines,
  diagnosisSuggestions,
  medicalProfileForPatient,
  LATEST_KEYS,
};
