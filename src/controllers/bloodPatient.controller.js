/**
 * Patient-side blood endpoints (/api/blood/*) — thin handlers.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const searchService = require("../services/bloodSearch.service");
const requestService = require("../services/bloodRequest.service");
const campService = require("../services/bloodCamp.service");
const sendFile = require("../utils/sendFile");

const me = (req) => req.user.id;

exports.reference = asyncHandler(async (_req, res) => ok(res, searchService.reference()));
exports.nearby = asyncHandler(async (req, res) => ok(res, await searchService.nearby(req.validatedQuery)));
exports.getBank = asyncHandler(async (req, res) => ok(res, { bank: await searchService.getBank(req.params.id) }));

exports.createRequest = asyncHandler(async (req, res) =>
  created(res, { request: await requestService.create(me(req), req.file, req.body) }, "Blood request sent")
);
exports.listRequests = asyncHandler(async (req, res) =>
  ok(res, await requestService.listForPatient(me(req), req.validatedQuery))
);
exports.getRequest = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.getForPatient(me(req), req.params.id) })
);
exports.cancelRequest = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.cancel(me(req), req.params.id, req.body) }, "Request cancelled")
);
exports.requestDocument = asyncHandler(async (req, res) =>
  sendFile(res, await requestService.streamDocument(me(req), req.params.id))
);

exports.history = asyncHandler(async (req, res) => ok(res, await searchService.history(me(req))));

exports.listCamps = asyncHandler(async (req, res) => ok(res, await campService.listPublic(req.validatedQuery)));
exports.myCamps = asyncHandler(async (req, res) => ok(res, { registrations: await campService.myRegistrations(me(req)) }));
exports.registerCamp = asyncHandler(async (req, res) =>
  created(res, { registration: await campService.register(me(req), req.params.id, req.body) }, "Registered for the camp")
);
exports.cancelCamp = asyncHandler(async (req, res) =>
  ok(res, { registration: await campService.cancelRegistration(me(req), req.params.id) }, "Registration cancelled")
);
