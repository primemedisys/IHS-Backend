/**
 * Admin verification controllers (guarded `role='admin'` in the routes). The
 * admin UI itself lives in `frontend-admin`; here we only expose the queue,
 * the per-doctor review view, and the approve/reject verdict.
 */
const verificationService = require("../services/verification.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeDoctorProfile } = require("../utils/serializers");

exports.listForReview = asyncHandler(async (req, res) => {
  const rows = await verificationService.listForReview(req.query.status);
  return ok(res, rows.map(serializeDoctorProfile), "Verification queue");
});

exports.getForReview = asyncHandler(async (req, res) => {
  const profile = await verificationService.getForReview(req.params.id);
  return ok(res, serializeDoctorProfile(profile), "Doctor for review");
});

exports.verify = asyncHandler(async (req, res) => {
  const profile = await verificationService.reviewDoctor(req.params.id, req.body);
  return ok(res, serializeDoctorProfile(profile), "Verification decision saved");
});

exports.setListing = asyncHandler(async (req, res) => {
  const profile = await verificationService.setListing(req.params.id, req.body.isListed);
  return ok(res, serializeDoctorProfile(profile), req.body.isListed ? "Doctor listed" : "Doctor hidden");
});
