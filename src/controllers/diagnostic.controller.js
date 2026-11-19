/**
 * Diagnostic Lab controller — thin handlers that delegate to the service.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const diagnosticService = require("../services/diagnostic.service");
const sendFile = require("../utils/sendFile");

// ── Patient ──────────────────────────────────────────────────────────────

exports.listLabs = asyncHandler(async (req, res) =>
  ok(res, await diagnosticService.listLabs(req.validatedQuery))
);

exports.shareRequest = asyncHandler(async (req, res) => {
  const requests = await diagnosticService.shareRequest(req.user.id, req.file, req.body);
  return created(res, { requests }, "Prescription shared with diagnostic lab");
});

exports.listMyRequests = asyncHandler(async (req, res) =>
  ok(res, await diagnosticService.listMyRequests(req.user.id, req.validatedQuery))
);

exports.book = asyncHandler(async (req, res) => {
  const request = await diagnosticService.book(req.user.id, req.params.id, req.body);
  return ok(res, { request }, "Booking sent to the lab");
});

// ── Lab ──────────────────────────────────────────────────────────────────

exports.listLabRequests = asyncHandler(async (req, res) =>
  ok(res, await diagnosticService.listLabRequests(req.user.id, req.validatedQuery))
);

exports.labSummary = asyncHandler(async (req, res) =>
  ok(res, await diagnosticService.labSummary(req.user.id))
);

exports.updateStatus = asyncHandler(async (req, res) => {
  const request = await diagnosticService.updateStatus(req.user.id, req.params.id, req.body.status, req.body.note);
  return ok(res, { request });
});

exports.respond = asyncHandler(async (req, res) => {
  const request = await diagnosticService.respond(req.user.id, req.params.id, req.body.tests, req.body.note);
  return ok(res, { request }, "Response sent to the patient");
});

exports.uploadReport = asyncHandler(async (req, res) => {
  const request = await diagnosticService.uploadReport(req.user.id, req.params.id, req.file, req.body);
  return created(res, { request }, "Report uploaded");
});

// ── Lab catalogue ────────────────────────────────────────────────────────

exports.listTests = asyncHandler(async (req, res) =>
  ok(res, { tests: await diagnosticService.listTests(req.user.id, req.validatedQuery) })
);

exports.createTest = asyncHandler(async (req, res) =>
  created(res, { test: await diagnosticService.createTest(req.user.id, req.body) }, "Test added")
);

exports.updateTest = asyncHandler(async (req, res) =>
  ok(res, { test: await diagnosticService.updateTest(req.user.id, req.params.id, req.body) }, "Test updated")
);

exports.removeTest = asyncHandler(async (req, res) =>
  ok(res, await diagnosticService.removeTest(req.user.id, req.params.id), "Test removed")
);

// ── Shared (patient or lab) ──────────────────────────────────────────────

exports.getRequest = asyncHandler(async (req, res) =>
  ok(res, { request: await diagnosticService.getRequest(req.user.id, req.params.id) })
);

exports.streamFile = asyncHandler(async (req, res) =>
  sendFile(res, await diagnosticService.streamFile(req.user.id, req.params.id))
);

exports.streamReport = asyncHandler(async (req, res) =>
  sendFile(res, await diagnosticService.streamReport(req.user.id, req.params.id, req.params.testId))
);
