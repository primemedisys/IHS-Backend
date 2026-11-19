/**
 * Doctor Dashboard 2.0 analytics — thin. `req.doctorId` is pinned to the
 * signed-in doctor by the route guard; services return plain JSON-ready data.
 */
const svc = require("../services/doctorAnalytics.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");

const handler = (fn, message) =>
  asyncHandler(async (req, res) => ok(res, await fn(req.doctorId, req.validatedQuery), message));

exports.overview = handler(svc.overview, "Dashboard overview");
exports.trends = handler(svc.trends, "Dashboard trends");
exports.patients = handler(svc.patientsDetail, "Patient analytics");
exports.appointments = handler(svc.appointmentsDetail, "Appointment analytics");
exports.financial = handler(svc.financialDetail, "Financial analytics");
exports.quality = handler(svc.qualityDetail, "Quality analytics");
exports.productivity = handler(svc.productivityDetail, "Productivity analytics");
exports.acquisition = handler(svc.acquisitionDetail, "Patient acquisition analytics");
