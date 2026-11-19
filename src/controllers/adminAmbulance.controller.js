/**
 * Admin Ambulance oversight (/api/admin/ambulances/*) — thin handlers.
 * Admin verifies / suspends providers, approves / deactivates individual
 * ambulances, and monitors bookings read-only (no write path into a trip).
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const providerService = require("../services/ambulanceProvider.service");
const fleetService = require("../services/ambulanceFleet.service");
const bookingService = require("../services/ambulanceBooking.service");
const dashboardService = require("../services/ambulanceDashboard.service");

exports.summary = asyncHandler(async (_req, res) => ok(res, await dashboardService.adminSummary(), "Ambulance summary"));

// Providers
exports.listProviders = asyncHandler(async (req, res) => ok(res, await providerService.adminList(req.validatedQuery)));
exports.getProvider = asyncHandler(async (req, res) => ok(res, { provider: await providerService.adminGet(req.params.id) }));
exports.verifyProvider = asyncHandler(async (req, res) =>
  ok(res, { provider: await providerService.adminVerify(req.user.id, req.params.id, req.body) }, "Verification recorded")
);
exports.setProviderActive = asyncHandler(async (req, res) =>
  ok(res, { provider: await providerService.adminSetActive(req.user.id, req.params.id, req.body.isActive) }, "Status updated")
);

// Ambulances
exports.listAmbulances = asyncHandler(async (req, res) => ok(res, await fleetService.adminListAmbulances(req.validatedQuery)));
exports.getAmbulance = asyncHandler(async (req, res) => ok(res, { ambulance: await fleetService.adminGetAmbulance(req.params.id) }));
exports.verifyAmbulance = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.adminVerifyAmbulance(req.user.id, req.params.id, req.body) }, "Verification recorded")
);
exports.setAmbulanceActive = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.adminSetAmbulanceActive(req.user.id, req.params.id, req.body.isActive) }, "Status updated")
);

// Bookings (monitoring)
exports.listBookings = asyncHandler(async (req, res) => ok(res, await bookingService.adminList(req.validatedQuery)));
exports.getBooking = asyncHandler(async (req, res) => ok(res, { booking: await bookingService.adminGet(req.params.id) }));
