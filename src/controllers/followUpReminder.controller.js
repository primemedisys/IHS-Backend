/**
 * Follow-up reminder controllers — deliberately THIN. Read `req.doctorId` (set by
 * resolveDoctorId) + validated input, call one followUpReminder.service function,
 * serialize.
 */
const followUpReminderService = require("../services/followUpReminder.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeReminder } = require("../utils/serializers");

exports.getReminder = asyncHandler(async (req, res) => {
  const row = await followUpReminderService.getReminder(req.doctorId, req.params.id);
  return ok(res, serializeReminder(row), "Reminder");
});

exports.setReminder = asyncHandler(async (req, res) => {
  const row = await followUpReminderService.setReminder(req.doctorId, req.params.id, req.body);
  return ok(res, serializeReminder(row), "Reminder saved");
});

exports.cancelReminder = asyncHandler(async (req, res) => {
  const result = await followUpReminderService.cancelReminder(req.doctorId, req.params.id);
  return ok(res, result, "Reminder cancelled");
});
