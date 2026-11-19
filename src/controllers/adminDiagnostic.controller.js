/**
 * Admin Diagnostic Lab tracking reads. THIN: validated query → one service
 * call → envelope. The service returns plain objects (raw SQL aggregates).
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const adminDiagnosticService = require("../services/adminDiagnostic.service");

exports.overview = asyncHandler(async (_req, res) =>
  ok(res, await adminDiagnosticService.overview(), "Diagnostic lab overview"));

exports.requests = asyncHandler(async (req, res) =>
  ok(res, await adminDiagnosticService.listRequests(req.validatedQuery), "Diagnostic requests"));
