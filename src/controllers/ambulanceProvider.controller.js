/**
 * Ambulance provider portal controller (frontend-ambulance) — thin handlers:
 * validated input → one service call → envelope. `req.providerId` is set by
 * requireApprovedAmbulanceProvider; the profile routes (open to a pending
 * provider) use req.user.id directly.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");
const authService = require("../services/auth.service");
const providerService = require("../services/ambulanceProvider.service");
const fleetService = require("../services/ambulanceFleet.service");
const bookingService = require("../services/ambulanceBooking.service");
const dashboardService = require("../services/ambulanceDashboard.service");
const searchService = require("../services/ambulanceSearch.service");

const provider = (req) => req.providerId;
const actor = (req) => req.user.id;

// ── Auth ─────────────────────────────────────────────────────────────────

exports.register = asyncHandler(async (req, res) => {
  const { user, profile, afterCreate } = providerService.splitRegistration(req.body);
  const result = await authService.registerLocal(user, req, profile, afterCreate);
  return created(
    res,
    { user: serializeUser(result.user), tokens: result.tokens, profile: await providerService.getOwn(result.user.id) },
    "Ambulance service registered — awaiting verification"
  );
});

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginAmbulanceProvider(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Logged in");
});

// ── Profile (open to a pending provider) ─────────────────────────────────

exports.getProfile = asyncHandler(async (req, res) => ok(res, { profile: await providerService.getOwn(actor(req)) }));
exports.updateProfile = asyncHandler(async (req, res) =>
  ok(res, { profile: await providerService.updateOwn(actor(req), req.body) }, "Profile updated")
);
exports.resubmit = asyncHandler(async (req, res) =>
  ok(res, { profile: await providerService.resubmit(actor(req)) }, "Resubmitted for verification")
);
exports.reference = asyncHandler(async (_req, res) => ok(res, searchService.reference()));

// ── Dashboard ────────────────────────────────────────────────────────────

exports.dashboard = asyncHandler(async (req, res) => ok(res, await dashboardService.providerDashboard(provider(req))));

// ── Ambulances ───────────────────────────────────────────────────────────

exports.listAmbulances = asyncHandler(async (req, res) =>
  ok(res, await fleetService.listAmbulances(provider(req), req.validatedQuery))
);
exports.getAmbulance = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.getAmbulance(provider(req), req.params.id) })
);
exports.createAmbulance = asyncHandler(async (req, res) =>
  created(res, { ambulance: await fleetService.createAmbulance(provider(req), req.body) }, "Ambulance added — awaiting verification")
);
exports.updateAmbulance = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.updateAmbulance(provider(req), req.params.id, req.body) }, "Ambulance updated")
);
exports.setAvailability = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.setAvailability(provider(req), req.params.id, req.body) }, "Availability updated")
);
exports.setDefaultDriver = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await fleetService.setDefaultDriver(provider(req), req.params.id, req.body) }, "Driver updated")
);

// ── Drivers ──────────────────────────────────────────────────────────────

exports.listDrivers = asyncHandler(async (req, res) => ok(res, await fleetService.listDrivers(provider(req), req.validatedQuery)));
exports.getDriver = asyncHandler(async (req, res) => ok(res, { driver: await fleetService.getDriver(provider(req), req.params.id) }));
exports.createDriver = asyncHandler(async (req, res) =>
  created(res, { driver: await fleetService.createDriver(provider(req), req.body) }, "Driver added")
);
exports.updateDriver = asyncHandler(async (req, res) =>
  ok(res, { driver: await fleetService.updateDriver(provider(req), req.params.id, req.body) }, "Driver updated")
);

// ── Bookings ─────────────────────────────────────────────────────────────

exports.listBookings = asyncHandler(async (req, res) =>
  ok(res, await bookingService.listForProvider(provider(req), req.validatedQuery))
);
exports.getBooking = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.getForProvider(provider(req), req.params.id) })
);
exports.accept = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.accept(provider(req), req.params.id, req.body) }, "Booking accepted")
);
exports.reject = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.reject(provider(req), req.params.id, req.body) }, "Booking rejected")
);
exports.assignDriver = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.assignDriver(provider(req), req.params.id, req.body) }, "Driver assigned")
);
exports.progress = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.progress(provider(req), req.params.id, req.body) }, "Status updated")
);
exports.complete = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.complete(provider(req), req.params.id, req.body) }, "Trip completed")
);
exports.cancel = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.cancelByProvider(provider(req), req.params.id, req.body) }, "Booking cancelled")
);
