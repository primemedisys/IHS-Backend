/**
 * Clinical-history consent (migration 057) — the ONE place that decides which
 * of a patient's clinical records a treating doctor may read.
 *
 * The rule, enforced on every doctor read path (EMR workspace, entries,
 * vitals, visit summary, history, treatment timeline, booking-level notes /
 * vitals / documents, prescription PDF):
 *
 *   - What the doctor created THEMSELVES is always theirs to read — their own
 *     visits, entries, prescriptions, notes, follow-ups, and vitals taken in
 *     their own visits (the current consultation is always one of these).
 *   - Everything another doctor (or the patient, a clinic, a lab) put on the
 *     record is grouped into seven categories. Each stays out of the response
 *     until the PATIENT approves that category for THIS doctor, and only until
 *     the approval expires or is revoked.
 *
 * Locked data is filtered in the database query (or before serialization) —
 * it never reaches the browser. Nothing is cached: the grant set is re-read on
 * every request, so a revocation applies to the very next call.
 *
 * The patient-declared intake (allergies, conditions and current medicines the
 * patient saved on their own profile for their doctors) stays visible to a
 * treating doctor, as before — it is not another doctor's record.
 */
const { Op } = require("sequelize");
const { sequelize, Booking, User, DoctorAccessRequest, DoctorProfile, MedicineNotification } = require("../models");
const ApiError = require("../utils/ApiError");
const { audit, expireStale, isActiveGrant, assertApprovedDoctor } = require("./accessGrants.service");
const { doctorLabel } = require("./appointmentNotification.service");
const {
  ERROR_CODES,
  TREATED_BOOKING_STATUSES,
  CLINICAL_ACCESS_CATEGORY: C,
  CLINICAL_ACCESS_CATEGORIES,
  CLINICAL_OPEN_CATEGORIES,
  CLINICAL_REREQUEST_COOLDOWN_HOURS,
  ACCESS_REQUEST_STATUS: S,
  ACCESS_REQUEST_TTL_DAYS,
  ACCESS_GRANT_DAYS,
  ACCESS_GRANT_DEFAULT_DAYS,
  ACCESS_AUDIT_ACTIONS: A,
  NOTIFICATION_TYPES: N,
  NOTIFICATION_REFS,
} = require("../config/constants");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** What each category covers, in the words both the doctor and the patient see. */
const CATEGORY_INFO = Object.freeze({
  [C.MEDICAL_HISTORY]: {
    label: "Medical history",
    description: "Past illnesses, family / social history and long-term conditions recorded by other doctors.",
  },
  [C.CONSULTATIONS]: {
    label: "Consultation records",
    description: "Other doctors' visits: chief complaint, examination, vitals taken in the visit and follow-up.",
  },
  [C.DIAGNOSES]: { label: "Diagnoses", description: "Diagnoses recorded by other doctors." },
  [C.MEDICATIONS]: {
    label: "Prescriptions & medicines",
    description: "Prescriptions written by other doctors, with medicines, doses and advice, and uploaded prescriptions.",
  },
  [C.INVESTIGATIONS]: {
    label: "Tests & reports",
    description:
      "Tests ordered by other doctors, and uploaded lab reports, scans and other medical documents (discharge summaries, hospital records, consultation reports, certificates).",
  },
  [C.DOCTOR_NOTES]: { label: "Doctor notes", description: "Notes written by other doctors." },
  [C.VITALS]: {
    label: "Vitals history",
    description: "Readings not taken in this doctor's own visits — at home, at a clinic or by other doctors.",
  },
});

/** Structured entry kind → the category that protects another doctor's entry of that kind. */
const KIND_CATEGORY = Object.freeze({
  complaint: C.CONSULTATIONS,
  examination: C.CONSULTATIONS,
  history: C.MEDICAL_HISTORY,
  comorbidity: C.MEDICAL_HISTORY,
  diagnosis: C.DIAGNOSES,
  investigation: C.INVESTIGATIONS,
  doctor_note: C.DOCTOR_NOTES,
});

/** uploaded_records.file_type → the category that protects that document. */
const FILE_TYPE_CATEGORY = Object.freeze({
  prescription: C.MEDICATIONS,
  lab_report: C.INVESTIGATIONS,
  xray: C.INVESTIGATIONS,
  mri: C.INVESTIGATIONS,
  other: C.INVESTIGATIONS,
});

// ── Scope ────────────────────────────────────────────────────────────────────
/**
 * A doctor's read scope over one patient: who they are + which categories they
 * may read. The common categories (CLINICAL_OPEN_CATEGORIES) are always in —
 * only prescriptions/medicines and tests/reports depend on the patient's grant.
 */
function makeScope(doctorId, patientId, categories = []) {
  const granted = new Set([...CLINICAL_OPEN_CATEGORIES, ...categories]);
  return {
    doctorId: String(doctorId),
    patientId: String(patientId),
    granted,
    has: (category) => granted.has(category),
    isOwn: (authorId) => authorId != null && String(authorId) === String(doctorId),
  };
}

/**
 * The categories this doctor holds an IN-FORCE approval for, re-read from the
 * database on every call (stale approvals are expired first).
 */
async function scopeFor(doctorId, patientId) {
  const where = { doctorId, patientId, category: { [Op.in]: CLINICAL_ACCESS_CATEGORIES } };
  await expireStale(where);
  const [rows, profile] = await Promise.all([
    DoctorAccessRequest.findAll({
      where: { ...where, status: S.APPROVED, grantExpiresAt: { [Op.gt]: new Date() } },
      attributes: ["category"],
      raw: true,
    }),
    DoctorProfile.findByPk(doctorId, { attributes: ["userId", "verificationStatus"], raw: true }),
  ]);
  // A doctor whose verification was withdrawn keeps the common categories but
  // loses patient grants — honoured again if re-approved before expiry.
  if (profile?.verificationStatus !== "approved") return makeScope(doctorId, patientId);
  return makeScope(doctorId, patientId, rows.map((r) => r.category));
}

// ── WHERE fragments (merge with [Op.and]) ────────────────────────────────────
/** Clinical entries: own entries + other doctors' entries of granted kinds. */
function entryWhere(scope) {
  const kinds = Object.entries(KIND_CATEGORY)
    .filter(([, category]) => scope.has(category))
    .map(([kind]) => kind);
  return kinds.length
    ? { [Op.or]: [{ doctorId: scope.doctorId }, { kind: { [Op.in]: kinds } }] }
    : { doctorId: scope.doctorId };
}

/** Rows owned through a doctor column, unless the category is granted. */
const ownedUnless = (scope, category, column = "doctorId") => (scope.has(category) ? {} : { [column]: scope.doctorId });

const bookingWhere = (scope) => ownedUnless(scope, C.CONSULTATIONS);
const prescriptionWhere = (scope) => ownedUnless(scope, C.MEDICATIONS);
const clinicalNoteWhere = (scope) => ownedUnless(scope, C.DOCTOR_NOTES);
const followUpWhere = (scope) => ownedUnless(scope, C.CONSULTATIONS);

/**
 * Vitals: everything when `vitals` is granted; otherwise only readings taken
 * in the doctor's OWN visits with this patient or recorded by the doctor.
 */
async function vitalsWhere(scope) {
  if (scope.has(C.VITALS)) return {};
  const own = await Booking.findAll({
    where: { doctorId: scope.doctorId, patientId: scope.patientId },
    attributes: ["id"],
    raw: true,
  });
  const or = [{ recordedByUserId: scope.doctorId }];
  if (own.length) or.push({ bookingId: { [Op.in]: own.map((b) => b.id) } });
  return { [Op.or]: or };
}

/**
 * Whether a doctor may see one uploaded document (added by them, or its
 * category granted). Identity documents (Aadhaar, insurance cards — migration
 * 058) are never visible to a doctor, whatever has been granted.
 */
function recordAllowed(scope, record) {
  if (record.fileType === "identity") return false;
  return scope.isOwn(record.recordedByUserId) || scope.has(FILE_TYPE_CATEGORY[record.fileType] ?? C.INVESTIGATIONS);
}

/** Categories still locked for this scope (for "locked" markers in responses). */
const lockedOf = (scope, categories = CLINICAL_ACCESS_CATEGORIES) => categories.filter((c) => !scope.has(c));

// ── Relationship ─────────────────────────────────────────────────────────────
/** A confirmed / completed booking between them — else 404 (never confirm the patient exists). */
async function assertTreats(doctorId, patientId) {
  const treated = await Booking.findOne({
    where: { doctorId, patientId, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
    attributes: ["id"],
  });
  if (!treated) throw ApiError.notFound("Patient not found");
}

// ── Access summary ───────────────────────────────────────────────────────────
/**
 * Per category, what the doctor holds and can do: granted (until when),
 * pending, recently declined (with when they may ask again), or nothing yet.
 * Built from this doctor's OWN requests only — it never reveals whether the
 * patient has records in a category, or what other doctors were granted.
 */
async function accessSummary(doctorId, patientId) {
  const where = { doctorId, patientId, category: { [Op.in]: CLINICAL_ACCESS_CATEGORIES } };
  await expireStale(where);
  const rows = await DoctorAccessRequest.findAll({ where, order: [["createdAt", "DESC"], ["id", "DESC"]], limit: 200 });
  const now = Date.now();
  const categories = CLINICAL_ACCESS_CATEGORIES.map((category) => {
    // Common information: visible to a treating doctor, nothing to request.
    if (CLINICAL_OPEN_CATEGORIES.includes(category)) {
      return {
        category,
        ...CATEGORY_INFO[category],
        status: "open",
        granted: true,
        grantExpiresAt: null,
        requestId: null,
        requestedAt: null,
        decidedAt: null,
        requestExpiresAt: null,
        canRequest: false,
        retryAt: null,
      };
    }
    const mine = rows.filter((r) => r.category === category);
    const active = mine.find(isActiveGrant) ?? null;
    const pending = mine.find((r) => r.status === S.PENDING) ?? null;
    const latest = mine[0] ?? null;
    const retryAt =
      latest && latest.status === S.REJECTED && latest.decidedAt
        ? new Date(new Date(latest.decidedAt).getTime() + CLINICAL_REREQUEST_COOLDOWN_HOURS * HOUR_MS)
        : null;
    const coolingDown = Boolean(retryAt && retryAt.getTime() > now);
    let status = "none";
    if (active) status = "granted";
    else if (pending) status = "pending";
    else if (latest) status = latest.status; // rejected / revoked / expired / cancelled
    const shown = active ?? pending ?? latest;
    return {
      category,
      ...CATEGORY_INFO[category],
      status,
      granted: Boolean(active),
      grantExpiresAt: active?.grantExpiresAt ?? null,
      requestId: shown ? String(shown.id) : null,
      requestedAt: shown?.createdAt ?? null,
      decidedAt: shown?.decidedAt ?? null,
      requestExpiresAt: pending?.requestExpiresAt ?? null,
      canRequest: !active && !pending && !coolingDown,
      retryAt: coolingDown ? retryAt : null,
    };
  });
  return {
    categories,
    grantedCount: categories.filter((c) => c.granted).length,
    grantDays: ACCESS_GRANT_DAYS,
    defaultGrantDays: ACCESS_GRANT_DEFAULT_DAYS,
  };
}

// ── Request ──────────────────────────────────────────────────────────────────
/**
 * A treating doctor asks for one or more clinical-history categories. Each
 * category becomes its own pending request (so the patient decides each one);
 * the patient gets ONE notification naming every category asked for.
 * Categories already granted, already pending, or declined within the
 * cool-down are skipped (and reported); if nothing is left to ask, 409.
 */
async function requestAccess(doctorId, patientId, { categories, purpose }, ctx) {
  await assertApprovedDoctor(doctorId);
  await assertTreats(doctorId, patientId);
  const summary = await accessSummary(doctorId, patientId);
  const byCategory = new Map(summary.categories.map((c) => [c.category, c]));
  const wanted = [...new Set(categories)];
  const askable = wanted.filter((c) => byCategory.get(c)?.canRequest);
  const skipped = wanted
    .filter((c) => !askable.includes(c))
    .map((c) => ({ category: c, reason: byCategory.get(c)?.status === "rejected" ? "cooldown" : byCategory.get(c)?.status }));

  if (!askable.length) {
    const cooling = skipped.some((s) => s.reason === "cooldown");
    const open = skipped.every((s) => s.reason === "open");
    throw ApiError.conflict(
      cooling
        ? "The patient recently declined this request. You can ask again later."
        : open
          ? "These records are already visible to you as a treating doctor."
          : "Those records are already shared with you or awaiting the patient's answer.",
      { code: cooling ? ERROR_CODES.ACCESS_REQUEST_COOLDOWN : ERROR_CODES.ACCESS_REQUEST_PENDING, details: { skipped } }
    );
  }

  const doctor = await User.findByPk(doctorId, { attributes: ["id", "name"] });
  const text = String(purpose ?? "").trim();
  await sequelize.transaction(async (transaction) => {
    // Re-check under a lock so two quick clicks can't open duplicate requests.
    const open = await DoctorAccessRequest.findAll({
      where: { doctorId, patientId, category: { [Op.in]: askable }, status: S.PENDING },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (open.length) {
      throw ApiError.conflict("You already have a pending request for these records", {
        code: ERROR_CODES.ACCESS_REQUEST_PENDING,
      });
    }
    const requestExpiresAt = new Date(Date.now() + ACCESS_REQUEST_TTL_DAYS * DAY_MS);
    const created = [];
    for (const category of askable) {
      // Sequential inside one transaction (a handful of rows at most).
      created.push(
        await DoctorAccessRequest.create(
          { doctorId, patientId, category, purpose: text, status: S.PENDING, requestExpiresAt },
          { transaction }
        )
      );
    }
    await audit(
      created.map((r) => ({
        action: A.REQUESTED,
        doctorId,
        patientId,
        entityType: "doctor_access_request",
        entityId: r.id,
        details: { category: r.category, scope: "clinical_history" },
      })),
      { transaction, ctx }
    );
    const labels = askable.map((c) => CATEGORY_INFO[c].label.toLowerCase());
    await MedicineNotification.create(
      {
        userId: patientId,
        type: N.ACCESS_REQUESTED,
        title: "Medical record access request",
        message: `${doctorLabel(doctor?.name)} has requested access to your previous medical records (${labels.join(", ")}). Review the request to approve or decline.`,
        referenceId: created[0].id,
        referenceType: NOTIFICATION_REFS.ACCESS_REQUEST,
      },
      { transaction }
    );
  });
  return { ...(await accessSummary(doctorId, patientId)), skipped };
}

/** The doctor's access summary for a patient they treat. */
async function summaryForDoctor(doctorId, patientId) {
  await assertTreats(doctorId, patientId);
  return accessSummary(doctorId, patientId);
}

module.exports = {
  CATEGORY_INFO,
  KIND_CATEGORY,
  FILE_TYPE_CATEGORY,
  makeScope,
  scopeFor,
  entryWhere,
  bookingWhere,
  prescriptionWhere,
  clinicalNoteWhere,
  followUpWhere,
  vitalsWhere,
  recordAllowed,
  lockedOf,
  assertTreats,
  accessSummary,
  summaryForDoctor,
  requestAccess,
};
