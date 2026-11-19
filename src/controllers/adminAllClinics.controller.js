/**
 * Admin "all clinics" controller — thin handlers for the total clinic details
 * page. Mirrors adminRegistry.controller shape: list with filters, serialize,
 * respond.
 */
const allClinicsService = require("../services/adminAllClinics.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeClinicProfile } = require("../utils/serializers");

exports.listAll = asyncHandler(async (req, res) => {
  const rows = await allClinicsService.listAll({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
    verificationStatus: req.query.verificationStatus,
    location: req.query.location,
  });
  return ok(res, rows.map(serializeClinicProfile), "All clinics");
});
