/**
 * Dashboard tile reads for all three portals. THIN: read validated input, call
 * exactly one service function, serialize, respond.
 *
 * Note what these controllers never do: read a doctor id from the client. The
 * doctor routes are guarded by `resolveDoctorId('self')`, so `req.doctorId` is
 * structurally the caller's own — not a `where` clause a refactor can drop.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const dashboardService = require("../services/dashboard.service");
const { resolveRange } = require("../utils/period");
const {
  serializePatientDashboard,
  serializeDoctorDashboard,
  serializeAdminDashboard,
  serializeBookingForDoctor,
  serializeBookingForAdmin,
} = require("../utils/serializers");

exports.patientSummary = asyncHandler(async (req, res) => {
  const data = await dashboardService.patientSummary(req.user.id);
  return ok(res, serializePatientDashboard(data), "Dashboard summary");
});

exports.doctorSummary = asyncHandler(async (req, res) => {
  const data = await dashboardService.doctorSummary(req.doctorId);
  return ok(res, serializeDoctorDashboard(data), "Dashboard summary");
});

exports.doctorToday = asyncHandler(async (req, res) => {
  const rows = await dashboardService.doctorToday(req.doctorId);
  return ok(res, rows.map(serializeBookingForDoctor), "Today's schedule");
});

exports.adminSummary = asyncHandler(async (req, res) => {
  const range = resolveRange(req.validatedQuery); // never req.query — see validators/dashboard
  const data = await dashboardService.adminSummary(range);
  return ok(res, serializeAdminDashboard(data), "Dashboard summary");
});

exports.adminBookings = asyncHandler(async (req, res) => {
  const rows = await dashboardService.adminBookings({
    status: req.query.status,
    q: req.query.q,
  });
  return ok(res, rows.map(serializeBookingForAdmin), "Bookings");
});
