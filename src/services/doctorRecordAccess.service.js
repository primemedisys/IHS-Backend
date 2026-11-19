/**
 * Doctor record-access consent (migration 045).
 *
 * THE EXISTING RULE IS UNCHANGED: a doctor who treats a patient (any
 * confirmed/completed booking together) already sees that patient's record
 * through the booking-keyed endpoints. This service adds the missing path for
 * every OTHER doctor:
 *
 *   1. An approved doctor searches the patient directory (basic, non-medical
 *      fields only — the same row the clinic directory returns).
 *   2. The doctor asks for ONE category of the patient's uploaded records, with
 *      a stated purpose. The patient is notified in-app.
 *   3. The PATIENT approves by choosing the exact documents to share (and for
 *      how long), or rejects. The doctor is notified either way.
 *   4. The doctor can open ONLY those documents, ONLY through
 *      `streamRecordForDoctor` (an authorized, no-store stream — the storage
 *      URL is never returned), and only until the grant expires or the patient
 *      revokes it.
 *
 * Every search, request, decision, revocation, expiry and download is written
 * to the append-only access_audit_logs table. Searching a patient grants
 * NOTHING; a notification grants NOTHING; only a patient's approval does.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  PatientProfile,
  DoctorProfile,
  Specialization,
  UploadedRecord,
  DoctorAccessRequest,
  DoctorAccessGrantItem,
  MedicineNotification,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const upload = require("./upload.service");
const userService = require("./user.service");
const { treatedPatientIds } = require("./treatmentTimeline.service");
const { doctorLabel } = require("./appointmentNotification.service");
const { audit, expireStale, isActiveGrant, assertApprovedDoctor } = require("./accessGrants.service");
const {
  ROLES,
  ERROR_CODES,
  ACCESS_REQUEST_STATUS: S,
  ACCESS_REQUEST_TTL_DAYS,
  ACCESS_GRANT_DEFAULT_DAYS,
  ACCESS_AUDIT_ACTIONS: A,
  CLINICAL_ACCESS_CATEGORIES,
  NOTIFICATION_TYPES: N,
  NOTIFICATION_REFS,
} = require("../config/constants");

const DAY_MS = 86_400_000;
const SEARCH_LIMIT = 20;

const CATEGORY_LABEL = Object.freeze({
  prescription: "prescriptions",
  lab_report: "lab reports",
  xray: "X-rays",
  mri: "MRI scans",
  other: "other medical documents",
  // Clinical-history categories (migration 057) — records written by other doctors.
  medical_history: "previous medical history",
  consultations: "previous consultation records",
  diagnoses: "previous diagnoses",
  medications: "previous prescriptions and medicines",
  investigations: "previous tests and reports",
  doctor_notes: "previous doctor notes",
  vitals: "previous vitals readings",
});

/** A clinical-history category is granted as a whole — it has no document picks. */
const isClinical = (category) => CLINICAL_ACCESS_CATEGORIES.includes(category);

// ── Shared helpers ────────────────────────────────────────────────────────────

/** An active patient account — 404 for anything else (never confirm a non-patient exists). */
async function findPatient(patientId) {
  const user = await User.findOne({
    where: { id: patientId, role: ROLES.PATIENT, isActive: true },
    include: [{ model: PatientProfile, as: "patientProfile" }],
  });
  if (!user) throw ApiError.notFound("Patient not found");
  return user;
}

function page({ page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

const recordAttrs = ["id", "patientId", "fileType", "tag", "recordDate", "uploadedAt", "source", "location"];

/** The patient's own records of one category, newest first. */
function recordsOfCategory(patientId, category, { transaction } = {}) {
  return UploadedRecord.findAll({
    where: { patientId, fileType: category },
    attributes: [...recordAttrs, "fileUrl"],
    order: [
      ["recordDate", "DESC"],
      ["uploadedAt", "DESC"],
    ],
    transaction,
  });
}

// ── Doctor side ───────────────────────────────────────────────────────────────

/**
 * GET /doctor/patient-search?q= — find a patient by name, phone or email.
 * Phone and email are SEARCHABLE but never RETURNED (same rule as the clinic
 * directory), and no medical data is returned. Result rows carry whether the
 * doctor already treats the patient.
 */
async function searchPatients(doctorId, { q }, ctx) {
  await assertApprovedDoctor(doctorId);
  const { data } = await userService.searchPatients({ q, page: 1, pageSize: SEARCH_LIMIT });
  const treated = await treatedPatientIds(doctorId, data.map((u) => u.id));
  await audit(
    {
      action: A.PATIENT_SEARCH,
      doctorId,
      details: {
        queryKind: q.includes("@") ? "email" : q.replace(/\D/g, "").length >= 6 ? "phone" : "name",
        resultIds: data.map((u) => String(u.id)),
      },
    },
    { ctx }
  );
  return { patients: data, treatedIds: treated };
}

/**
 * GET /doctor/patient-search/:patientId — the basic card for one patient plus
 * this doctor's own requests for them. Never any medical content.
 */
async function getPatientForDoctor(doctorId, patientId, ctx) {
  await assertApprovedDoctor(doctorId);
  const patient = await findPatient(patientId);
  await expireStale({ doctorId, patientId: patient.id });
  const [treated, requests] = await Promise.all([
    treatedPatientIds(doctorId, [patient.id]),
    DoctorAccessRequest.findAll({
      where: { doctorId, patientId: patient.id },
      include: [{ model: DoctorAccessGrantItem, as: "items", attributes: ["id", "recordId"] }],
      order: [["createdAt", "DESC"]],
      limit: 50,
    }),
  ]);
  await audit(
    { action: A.PATIENT_VIEW, doctorId, patientId: patient.id, entityType: "user", entityId: patient.id },
    { ctx }
  );
  return { patient, treating: treated.has(String(patient.id)), requests };
}

/** POST /doctor/access-requests */
async function createRequest(doctorId, body, ctx) {
  const request = await insertRequest(doctorId, body, ctx);
  return getForDoctor(doctorId, request.id);
}

async function insertRequest(doctorId, { patientId, category, purpose }, ctx) {
  await assertApprovedDoctor(doctorId);
  const patient = await findPatient(patientId);

  // The existing clinical relationship already gives access — don't impose a
  // duplicate consent step on it.
  const treated = await treatedPatientIds(doctorId, [patient.id]);
  if (treated.has(String(patient.id))) {
    throw ApiError.conflict(
      "You treat this patient — ask for their previous records from the patient's workbench instead",
      { code: ERROR_CODES.ACCESS_ALREADY_AUTHORIZED }
    );
  }

  await expireStale({ doctorId, patientId: patient.id });
  const doctor = await User.findByPk(doctorId, { attributes: ["id", "name"] });

  return sequelize.transaction(async (transaction) => {
    const open = await DoctorAccessRequest.findOne({
      where: { doctorId, patientId: patient.id, category, status: S.PENDING },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (open) {
      throw ApiError.conflict("You already have a pending request for these records", {
        code: ERROR_CODES.ACCESS_REQUEST_PENDING,
      });
    }

    const request = await DoctorAccessRequest.create(
      {
        doctorId,
        patientId: patient.id,
        category,
        purpose,
        status: S.PENDING,
        requestExpiresAt: new Date(Date.now() + ACCESS_REQUEST_TTL_DAYS * DAY_MS),
      },
      { transaction }
    );
    await audit(
      {
        action: A.REQUESTED,
        doctorId,
        patientId: patient.id,
        entityType: "doctor_access_request",
        entityId: request.id,
        details: { category },
      },
      { transaction, ctx }
    );
    // Persisted in the same transaction; the realtime hook pushes it on commit.
    await MedicineNotification.create(
      {
        userId: patient.id,
        type: N.ACCESS_REQUESTED,
        title: "Record access request",
        message: `${doctorLabel(doctor?.name)} is asking to see your ${CATEGORY_LABEL[category]}. Review the request to approve or decline.`,
        referenceId: request.id,
        referenceType: NOTIFICATION_REFS.ACCESS_REQUEST,
      },
      { transaction }
    );
    return request;
  });
}

/** GET /doctor/access-requests */
async function listForDoctor(doctorId, { patientId, status, ...paging } = {}) {
  const scope = { doctorId, ...(patientId ? { patientId } : {}) };
  await expireStale(scope);
  const { page: p, limit, offset } = page(paging);
  const { rows, count } = await DoctorAccessRequest.findAndCountAll({
    where: { ...scope, ...(status ? { status } : {}) },
    include: [
      { model: User, as: "patient", attributes: ["id", "name", "profilePhotoUrl"] },
      { model: DoctorAccessGrantItem, as: "items", attributes: ["id", "recordId"] },
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
    distinct: true,
  });
  return { rows, total: count, page: p, limit, totalPages: Math.max(1, Math.ceil(count / limit)) };
}

/**
 * GET /doctor/access-requests/:id — the request, and (only while the grant is
 * in force) the METADATA of the shared documents. Never a storage URL.
 */
async function getForDoctor(doctorId, id) {
  // A doctor whose verification was withdrawn loses consented access too.
  await assertApprovedDoctor(doctorId);
  await expireStale({ id, doctorId });
  const request = await DoctorAccessRequest.findOne({
    where: { id, doctorId },
    include: [
      { model: User, as: "patient", attributes: ["id", "name", "profilePhotoUrl"] },
      {
        model: DoctorAccessGrantItem,
        as: "items",
        include: [{ model: UploadedRecord, as: "record", attributes: recordAttrs }],
      },
    ],
  });
  if (!request) throw ApiError.notFound("Request not found");
  return request;
}

/** POST /doctor/access-requests/:id/cancel — withdraw a still-pending request. */
async function cancelForDoctor(doctorId, id, ctx) {
  await sequelize.transaction(async (transaction) => {
    const request = await DoctorAccessRequest.findOne({ where: { id, doctorId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!request) throw ApiError.notFound("Request not found");
    if (request.status !== S.PENDING) {
      throw ApiError.conflict("Only a pending request can be withdrawn", { code: ERROR_CODES.ACCESS_REQUEST_CLOSED });
    }
    request.status = S.CANCELLED;
    request.decidedAt = new Date();
    await request.save({ transaction });
    await audit(
      { action: A.CANCELLED, doctorId, patientId: request.patientId, entityType: "doctor_access_request", entityId: request.id },
      { transaction, ctx }
    );
  });
  return getForDoctor(doctorId, id);
}

/**
 * GET /doctor/access-requests/:id/records/:recordId/file — stream ONE shared
 * document. Every condition is re-checked on every read: own request,
 * approved, not expired, not revoked, the record is in the grant, and it still
 * belongs to that patient. Each successful read is audited.
 */
async function streamRecordForDoctor(doctorId, requestId, recordId, ctx) {
  await assertApprovedDoctor(doctorId);
  const request = await DoctorAccessRequest.findOne({ where: { id: requestId, doctorId } });
  if (!request) throw ApiError.notFound("Request not found");
  const denied = () =>
    ApiError.forbidden("You don't have access to this document", { code: ERROR_CODES.ACCESS_NOT_GRANTED });
  if (!isActiveGrant(request)) {
    await expireStale({ id: request.id });
    throw denied();
  }
  const item = await DoctorAccessGrantItem.findOne({
    where: { requestId: request.id, recordId },
    include: [{ model: UploadedRecord, as: "record", attributes: [...recordAttrs, "fileUrl"] }],
  });
  const record = item?.record;
  if (!record || !sameId(record.patientId, request.patientId)) throw denied();

  const buffer = await upload.readByUrl(record.fileUrl);
  if (!buffer) throw ApiError.notFound("The document file is no longer available");

  await audit(
    {
      action: A.RECORD_DOWNLOADED,
      doctorId,
      patientId: request.patientId,
      entityType: "uploaded_record",
      entityId: record.id,
      details: { requestId: String(request.id) },
    },
    { ctx }
  );
  const name = decodeURIComponent(String(record.fileUrl).split("/").pop() || `record-${record.id}`).replace(/^[0-9a-f-]{36}-/i, "");
  return { buffer, contentType: upload.contentTypeFor(name), fileName: name };
}

// ── Patient side ──────────────────────────────────────────────────────────────

const doctorInclude = {
  model: User,
  as: "doctor",
  attributes: ["id", "name", "profilePhotoUrl"],
  include: [
    {
      model: DoctorProfile,
      as: "doctorProfile",
      attributes: ["userId", "qualification", "verificationStatus", "headline"],
      include: [{ model: Specialization, as: "specializations", attributes: ["id", "name"], through: { attributes: [] } }],
    },
  ],
};

/** Re-read a request with what the patient's view needs (after a write). */
function reloadForPatient(id) {
  return DoctorAccessRequest.findByPk(id, {
    include: [doctorInclude, { model: DoctorAccessGrantItem, as: "items", attributes: ["id", "recordId"] }],
  });
}

/** GET /patient/access-requests */
async function listForPatient(patientId, { status, ...paging } = {}) {
  await expireStale({ patientId });
  const { page: p, limit, offset } = page(paging);
  const { rows, count } = await DoctorAccessRequest.findAndCountAll({
    where: { patientId, ...(status ? { status } : {}) },
    include: [doctorInclude, { model: DoctorAccessGrantItem, as: "items", attributes: ["id", "recordId"] }],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
    distinct: true,
  });
  return { rows, total: count, page: p, limit, totalPages: Math.max(1, Math.ceil(count / limit)) };
}

/**
 * GET /patient/access-requests/:id — who is asking, for what and why, plus
 * the patient's OWN documents in that category to choose from.
 */
async function getForPatient(patientId, id) {
  await expireStale({ id, patientId });
  const request = await DoctorAccessRequest.findOne({
    where: { id, patientId },
    include: [doctorInclude, { model: DoctorAccessGrantItem, as: "items", attributes: ["id", "recordId"] }],
  });
  if (!request) throw ApiError.notFound("Request not found");
  // A clinical-history request is approved as a whole — there is nothing to pick.
  const candidates = isClinical(request.category) ? null : await recordsOfCategory(patientId, request.category);
  return { request, candidates };
}

/** Decide a still-pending, unexpired request — locked so two taps can't race. */
async function decide(patientId, id, ctx, apply) {
  await expireStale({ id, patientId });
  return sequelize.transaction(async (transaction) => {
    const request = await DoctorAccessRequest.findOne({
      where: { id, patientId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!request) throw ApiError.notFound("Request not found");
    if (request.status !== S.PENDING) {
      throw ApiError.conflict("This request has already been answered or has expired", {
        code: ERROR_CODES.ACCESS_REQUEST_CLOSED,
      });
    }
    return apply(request, transaction);
  });
}

async function notifyDoctor(request, type, title, message, transaction) {
  await MedicineNotification.create(
    {
      userId: request.doctorId,
      type,
      title,
      message,
      referenceId: request.id,
      referenceType: NOTIFICATION_REFS.ACCESS_REQUEST,
    },
    { transaction }
  );
}

async function patientName(patientId) {
  const u = await User.findByPk(patientId, { attributes: ["id", "name"] });
  return u?.name || "The patient";
}

/**
 * POST /patient/access-requests/:id/approve { recordIds, durationDays }
 * The grant is EXACTLY the chosen documents — each must be the patient's own
 * and of the requested category.
 */
async function approve(patientId, id, { recordIds = [], durationDays = ACCESS_GRANT_DEFAULT_DAYS }, ctx) {
  const name = await patientName(patientId);
  const decided = await decide(patientId, id, ctx, async (request, transaction) => {
    if (isClinical(request.category)) {
      return approveClinical(request, { name, durationDays, ctx, transaction });
    }
    const ids = [...new Set(recordIds.map(String))];
    if (!ids.length) {
      throw ApiError.badRequest("Choose at least one document to share", { code: ERROR_CODES.VALIDATION_ERROR });
    }
    const records = await UploadedRecord.findAll({
      where: { id: { [Op.in]: ids }, patientId, fileType: request.category },
      attributes: ["id"],
      transaction,
    });
    if (records.length !== ids.length) {
      throw ApiError.badRequest("Choose documents from your own records of the requested type", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    const now = new Date();
    await DoctorAccessGrantItem.bulkCreate(
      records.map((r) => ({ requestId: request.id, recordId: r.id })),
      { transaction }
    );
    request.status = S.APPROVED;
    request.decidedAt = now;
    request.grantExpiresAt = new Date(now.getTime() + durationDays * DAY_MS);
    await request.save({ transaction });
    await audit(
      {
        action: A.APPROVED,
        doctorId: request.doctorId,
        patientId,
        entityType: "doctor_access_request",
        entityId: request.id,
        details: { recordIds: ids, durationDays, grantExpiresAt: request.grantExpiresAt.toISOString() },
      },
      { transaction, ctx }
    );
    await notifyDoctor(
      request,
      N.ACCESS_APPROVED,
      "Record access approved",
      `${name} shared ${ids.length} ${ids.length === 1 ? "document" : "documents"} (${CATEGORY_LABEL[request.category]}) with you for ${durationDays} days.`,
      transaction
    );
    return request;
  });
  return reloadForPatient(decided.id);
}

/**
 * Approve ONE clinical-history category (migration 057). The grant is the
 * category itself, for this doctor only, until it expires or is revoked; every
 * read re-checks it (clinicalAccess.service). Nothing else is granted.
 */
async function approveClinical(request, { name, durationDays, ctx, transaction }) {
  const now = new Date();
  request.status = S.APPROVED;
  request.decidedAt = now;
  request.grantExpiresAt = new Date(now.getTime() + durationDays * DAY_MS);
  await request.save({ transaction });
  await audit(
    {
      action: A.APPROVED,
      doctorId: request.doctorId,
      patientId: request.patientId,
      entityType: "doctor_access_request",
      entityId: request.id,
      details: { category: request.category, durationDays, grantExpiresAt: request.grantExpiresAt.toISOString() },
    },
    { transaction, ctx }
  );
  await notifyDoctor(
    request,
    N.ACCESS_APPROVED,
    "Record access approved",
    `${name} shared their ${CATEGORY_LABEL[request.category]} with you for ${durationDays} days.`,
    transaction
  );
  return request;
}

/** POST /patient/access-requests/:id/reject { note? } */
async function reject(patientId, id, { note = null } = {}, ctx) {
  const name = await patientName(patientId);
  const decided = await decide(patientId, id, ctx, async (request, transaction) => {
    request.status = S.REJECTED;
    request.decidedAt = new Date();
    request.decisionNote = note || null;
    await request.save({ transaction });
    await audit(
      {
        action: A.REJECTED,
        doctorId: request.doctorId,
        patientId,
        entityType: "doctor_access_request",
        entityId: request.id,
        details: { category: request.category },
      },
      { transaction, ctx }
    );
    await notifyDoctor(
      request,
      N.ACCESS_REJECTED,
      "Record access declined",
      `${name} declined your request to see their ${CATEGORY_LABEL[request.category]}.`,
      transaction
    );
    return request;
  });
  return reloadForPatient(decided.id);
}

/** POST /patient/access-requests/:id/revoke — end an approval early. */
async function revoke(patientId, id, ctx) {
  const name = await patientName(patientId);
  await expireStale({ id, patientId });
  const revoked = await sequelize.transaction(async (transaction) => {
    const request = await DoctorAccessRequest.findOne({ where: { id, patientId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!request) throw ApiError.notFound("Request not found");
    if (request.status !== S.APPROVED) {
      throw ApiError.conflict("Only an active approval can be revoked", { code: ERROR_CODES.ACCESS_REQUEST_CLOSED });
    }
    request.status = S.REVOKED;
    request.revokedAt = new Date();
    await request.save({ transaction });
    await audit(
      {
        action: A.REVOKED,
        doctorId: request.doctorId,
        patientId,
        entityType: "doctor_access_request",
        entityId: request.id,
        details: { category: request.category },
      },
      { transaction, ctx }
    );
    await notifyDoctor(
      request,
      N.ACCESS_REVOKED,
      "Record access revoked",
      `${name} withdrew your access to their ${CATEGORY_LABEL[request.category]}.`,
      transaction
    );
    return request;
  });
  return reloadForPatient(revoked.id);
}

module.exports = {
  searchPatients,
  getPatientForDoctor,
  createRequest,
  listForDoctor,
  getForDoctor,
  cancelForDoctor,
  streamRecordForDoctor,
  listForPatient,
  getForPatient,
  approve,
  reject,
  revoke,
  isActiveGrant,
  isClinical,
  CATEGORY_LABEL,
};
