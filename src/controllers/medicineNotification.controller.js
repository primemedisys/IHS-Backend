const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const medicineNotificationService = require("../services/medicineNotification.service");

exports.listByUser = asyncHandler(async (req, res) => {
  const result = await medicineNotificationService.listByUser(req.user.id, req.query);
  return ok(res, result);
});

exports.markAsRead = asyncHandler(async (req, res) => {
  const notification = await medicineNotificationService.markAsRead(req.user.id, req.params.id);
  return ok(res, { notification });
});

exports.markAllAsRead = asyncHandler(async (req, res) => {
  await medicineNotificationService.markAllAsRead(req.user.id);
  return ok(res, null, "All notifications marked as read");
});

exports.getUnreadCount = asyncHandler(async (req, res) => {
  const result = await medicineNotificationService.getUnreadCount(req.user.id);
  return ok(res, result);
});

exports.deleteOne = asyncHandler(async (req, res) => {
  const result = await medicineNotificationService.deleteOne(req.user.id, req.params.id);
  return ok(res, result);
});
