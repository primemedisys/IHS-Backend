/**
 * Admin Blood Bank oversight (/api/admin/blood-banks/*) — thin handlers.
 * Admin verifies / suspends blood banks and reads aggregate statistics; it has
 * NO write path into units, requests, cross-matches or issues (no medical
 * authority).
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const profileService = require("../services/bloodBankProfile.service");
const dashboardService = require("../services/bloodDashboard.service");

exports.summary = asyncHandler(async (_req, res) => ok(res, await dashboardService.adminSummary(), "Blood bank summary"));
exports.listBanks = asyncHandler(async (req, res) => ok(res, await profileService.adminList(req.validatedQuery)));
exports.getBank = asyncHandler(async (req, res) => ok(res, { bank: await profileService.adminGet(req.params.id) }));
exports.verify = asyncHandler(async (req, res) =>
  ok(res, { bank: await profileService.adminVerify(req.user.id, req.params.id, req.body) }, "Verification recorded")
);
exports.setActive = asyncHandler(async (req, res) =>
  ok(res, { bank: await profileService.adminSetActive(req.user.id, req.params.id, req.body.isActive) }, "Status updated")
);
exports.inventory = asyncHandler(async (req, res) =>
  ok(res, { rows: await dashboardService.adminInventory(req.validatedQuery) }, "Blood inventory")
);
exports.requests = asyncHandler(async (req, res) =>
  ok(res, await dashboardService.adminRequests(req.validatedQuery), "Blood requests")
);
