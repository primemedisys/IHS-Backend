/**
 * Public ambulance discovery + patient bookings (/api/ambulances/*) — thin
 * handlers. Discovery is public (no account needed to find an ambulance);
 * booking and "my bookings" are patient-only and scoped to req.user.id.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const searchService = require("../services/ambulanceSearch.service");
const bookingService = require("../services/ambulanceBooking.service");

const me = (req) => req.user.id;

// ── Public ───────────────────────────────────────────────────────────────

exports.reference = asyncHandler(async (_req, res) => ok(res, searchService.reference()));
exports.nearby = asyncHandler(async (req, res) => ok(res, await searchService.nearby(req.validatedQuery)));
exports.getAmbulance = asyncHandler(async (req, res) =>
  ok(res, { ambulance: await searchService.getPublic(req.params.id, req.validatedQuery) })
);
exports.estimate = asyncHandler(async (req, res) =>
  ok(res, { estimate: await searchService.estimate(req.params.id, req.validatedQuery) })
);

// ── Patient bookings ─────────────────────────────────────────────────────

exports.createBooking = asyncHandler(async (req, res) =>
  created(res, { booking: await bookingService.create(me(req), req.body) }, "Ambulance booking requested")
);
exports.listBookings = asyncHandler(async (req, res) => ok(res, await bookingService.listForPatient(me(req), req.validatedQuery)));
exports.getBooking = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.getForPatient(me(req), req.params.id) })
);
exports.cancelBooking = asyncHandler(async (req, res) =>
  ok(res, { booking: await bookingService.cancelByPatient(me(req), req.params.id, req.body) }, "Booking cancelled")
);
