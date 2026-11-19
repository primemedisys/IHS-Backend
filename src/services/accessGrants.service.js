/**
 * The low-level pieces every consent path shares (migrations 045 + 057):
 * append-only audit rows, lazy expiry of stale requests, the "is this grant in
 * force" test and the verified-doctor check.
 *
 * Kept free of other services on purpose, so both the document consent flow
 * (doctorRecordAccess.service) and the clinical-history gate
 * (clinicalAccess.service, used by the EMR, timeline, vitals and notes
 * services) can depend on it without a require cycle.
 */
const { Op } = require("sequelize");
const { sequelize, DoctorAccessRequest, AccessAuditLog, DoctorProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { ACCESS_REQUEST_STATUS: S, ACCESS_AUDIT_ACTIONS: A, ERROR_CODES } = require("../config/constants");

/** Append-only audit rows (inside the caller's transaction when given). */
function audit(entries, { transaction, ctx } = {}) {
  const rows = (Array.isArray(entries) ? entries : [entries]).map((e) => ({
    actorUserId: ctx?.userId ?? null,
    actorRole: ctx?.role ?? null,
    ip: ctx?.ip ? String(ctx.ip).slice(0, 64) : null,
    ...e,
  }));
  return AccessAuditLog.bulkCreate(rows, { transaction });
}

/**
 * Lazily close requests whose clock has run out (pending → expired after the
 * request TTL; approved → expired at grant_expires_at), scoped to the rows the
 * caller is about to read. Each expiry is audited once.
 */
async function expireStale(scope) {
  const now = new Date();
  const stale = await DoctorAccessRequest.findAll({
    where: {
      ...scope,
      [Op.or]: [
        { status: S.PENDING, requestExpiresAt: { [Op.lte]: now } },
        { status: S.APPROVED, grantExpiresAt: { [Op.lte]: now } },
      ],
    },
    attributes: ["id", "doctorId", "patientId", "status", "category"],
  });
  if (!stale.length) return;
  await sequelize.transaction(async (transaction) => {
    await DoctorAccessRequest.update(
      { status: S.EXPIRED },
      { where: { id: { [Op.in]: stale.map((r) => r.id) }, status: { [Op.in]: [S.PENDING, S.APPROVED] } }, transaction }
    );
    await audit(
      stale.map((r) => ({
        action: A.EXPIRED,
        doctorId: r.doctorId,
        patientId: r.patientId,
        entityType: "doctor_access_request",
        entityId: r.id,
        details: { from: r.status, category: r.category },
      })),
      { transaction }
    );
  });
}

/** True while an approval is in force (approved and not past its expiry). */
function isActiveGrant(request) {
  return request.status === S.APPROVED && !!request.grantExpiresAt && new Date(request.grantExpiresAt) > new Date();
}

/** Search / request require a VERIFIED doctor — an unvetted account gets nothing. */
async function assertApprovedDoctor(doctorId) {
  const profile = await DoctorProfile.findByPk(doctorId, { attributes: ["userId", "verificationStatus"] });
  if (!profile || profile.verificationStatus !== "approved") {
    throw ApiError.forbidden("Only verified doctors can search patients or request records", {
      code: ERROR_CODES.DOCTOR_NOT_VERIFIED,
    });
  }
}

module.exports = { audit, expireStale, isActiveGrant, assertApprovedDoctor };
