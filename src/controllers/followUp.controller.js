/**
 * Follow-up status controllers — deliberately THIN. Read `req.doctorId` (set by
 * resolveDoctorId) + validated input, call one followUp.service function,
 * serialize.
 */
const followUpService = require("../services/followUp.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { serializeFollowUpStatus, serializeFollowUp } = require("../utils/serializers");

// ── The doctor's option list ─────────────────────────────────────────────────
exports.listStatuses = asyncHandler(async (req, res) => {
  const rows = await followUpService.listStatuses(req.doctorId);
  return ok(res, rows.map(serializeFollowUpStatus), "Follow-up statuses");
});

exports.createStatus = asyncHandler(async (req, res) => {
  const row = await followUpService.createStatus(req.doctorId, req.body);
  return created(res, serializeFollowUpStatus(row), "Follow-up status added");
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const row = await followUpService.updateStatus(req.doctorId, req.params.id, req.body);
  return ok(res, serializeFollowUpStatus(row), "Follow-up status updated");
});

exports.deleteStatus = asyncHandler(async (req, res) => {
  const result = await followUpService.deleteStatus(req.doctorId, req.params.id);
  return ok(res, result, "Follow-up status deleted");
});

exports.reorderStatuses = asyncHandler(async (req, res) => {
  const rows = await followUpService.reorderStatuses(req.doctorId, req.body.ids);
  return ok(res, rows.map(serializeFollowUpStatus), "Order saved");
});

// ── One consultation's follow-up ─────────────────────────────────────────────
// Keyed on the BOOKING: re-tagging one visit must leave that patient's other
// visits untouched.
exports.getBookingFollowUp = asyncHandler(async (req, res) => {
  const row = await followUpService.getBookingFollowUp(req.doctorId, req.params.id);
  return ok(res, serializeFollowUp(row), "Follow-up");
});

exports.setBookingFollowUp = asyncHandler(async (req, res) => {
  const row = await followUpService.setBookingFollowUp(req.doctorId, req.params.id, req.body);
  return ok(res, serializeFollowUp(row), "Follow-up saved");
});

exports.clearBookingFollowUp = asyncHandler(async (req, res) => {
  const result = await followUpService.clearBookingFollowUp(req.doctorId, req.params.id);
  return ok(res, result, "Follow-up cleared");
});
