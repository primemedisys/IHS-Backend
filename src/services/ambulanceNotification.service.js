/**
 * The ONE place the ambulance module sends notifications — in-app, through the
 * EXISTING medicine_notifications table that the pharmacy, diagnostic-lab and
 * blood-bank modules already share (no second notification system). Always
 * called inside the transaction that makes the change, so a status change and
 * its notification commit (or roll back) together.
 */
const { MedicineNotification } = require("../models");

/**
 * @param {Array<{userId, title, message, type, referenceId?, referenceType}>|object} rows
 * @param {import('sequelize').Transaction} [transaction]
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

module.exports = { notify };
