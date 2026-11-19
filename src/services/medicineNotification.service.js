const { MedicineNotification } = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");

exports.listByUser = async (userId, { unreadOnly = false, page = 1, limit = 20 } = {}) => {
  const where = { userId };
  if (unreadOnly) where.isRead = false;

  const offset = (page - 1) * limit;
  const { rows, count } = await MedicineNotification.findAndCountAll({
    where,
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset,
  });

  const unreadCount = await MedicineNotification.count({ where: { userId, isRead: false } });

  return { notifications: rows, total: count, unreadCount, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.markAsRead = async (userId, notificationId) => {
  const notif = await MedicineNotification.findByPk(notificationId);
  if (!notif) throw ApiError.notFound("Notification not found");
  if (!sameId(notif.userId, userId)) throw ApiError.forbidden("Not authorized");
  await notif.update({ isRead: true });
  return notif;
};

exports.markAllAsRead = async (userId) => {
  await MedicineNotification.update({ isRead: true }, { where: { userId, isRead: false } });
  return { success: true };
};

exports.getUnreadCount = async (userId) => {
  const count = await MedicineNotification.count({ where: { userId, isRead: false } });
  return { unreadCount: count };
};

exports.deleteOne = async (userId, notificationId) => {
  const notif = await MedicineNotification.findByPk(notificationId);
  if (!notif) throw ApiError.notFound("Notification not found");
  if (!sameId(notif.userId, userId)) throw ApiError.forbidden("Not authorized");
  await notif.destroy();
  return { id: String(notificationId) };
};
