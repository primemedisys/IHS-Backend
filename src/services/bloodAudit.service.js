/**
 * The Blood Bank audit trail (blood_audit_logs). The project has no generic
 * audit system, so this is the small, module-local one: every important
 * operation writes one row INSIDE the transaction that makes the change, so a
 * change and its audit entry commit (or roll back) together.
 *
 * Also the ONE place the blood module sends in-app notifications, through the
 * EXISTING medicine_notifications table (no second notification system).
 */
const { Op } = require("sequelize");
const { BloodAuditLog, MedicineNotification, User } = require("../models");

/**
 * @param {Array<{bloodBankId, actorUserId?, entityType, entityId, action, fromStatus?, toStatus?, details?}>} entries
 * @param {import('sequelize').Transaction} [transaction]
 */
function record(entries, transaction) {
  const rows = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!rows.length) return Promise.resolve([]);
  return BloodAuditLog.bulkCreate(
    rows.map((e) => ({
      bloodBankId: e.bloodBankId,
      actorUserId: e.actorUserId ?? null,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      details: e.details ?? null,
    })),
    { transaction }
  );
}

/**
 * In-app notifications via the existing medicine_notifications table.
 * @param {Array<{userId, title, message, type, referenceId?, referenceType}>} rows
 */
function notify(rows, transaction) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return Promise.resolve([]);
  return MedicineNotification.bulkCreate(
    list.map((n) => ({
      userId: n.userId,
      title: n.title,
      message: n.message,
      type: n.type,
      referenceId: n.referenceId ?? null,
      referenceType: n.referenceType,
    })),
    { transaction }
  );
}

/** A bank's own audit trail, newest first (optionally for one entity). */
async function listForBank(bloodBankId, { entityType, entityId, page = 1, limit = 50 } = {}) {
  const where = { bloodBankId };
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  const { rows, count } = await BloodAuditLog.findAndCountAll({
    where,
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { entries: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
}

/** Audit rows for several entities at once (unit history + its reservations …). */
function forEntities(bloodBankId, pairs) {
  if (!pairs.length) return Promise.resolve([]);
  return BloodAuditLog.findAll({
    where: {
      bloodBankId,
      [Op.or]: pairs.map(([entityType, entityId]) => ({ entityType, entityId })),
    },
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
    order: [["createdAt", "ASC"], ["id", "ASC"]],
  });
}

module.exports = { record, notify, listForBank, forEntities };
