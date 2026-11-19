/**
 * Admin clinic-verification controllers (guarded `role='admin'` in the routes).
 *
 * Mirrors adminDoctor.controller exactly, because the two queues are the same
 * workflow: a pending queue, a review view, an approve/reject verdict, and an
 * independent suspend switch.
 *
 * This queue matters more than the doctor one: an approved clinic can read
 * EVERY registered patient's record, so approval is the only thing standing
 * between a self-registered account and the whole patient directory.
 */
const clinicPortalService = require("../services/clinicPortal.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeClinicProfile } = require("../utils/serializers");

exports.listForReview = asyncHandler(async (req, res) => {
  const rows = await clinicPortalService.listForReview(req.query.status);
  return ok(res, rows.map(serializeClinicProfile), "Clinic verification queue");
});

exports.getForReview = asyncHandler(async (req, res) => {
  const profile = await clinicPortalService.getForReview(req.params.id);
  return ok(res, serializeClinicProfile(profile), "Clinic for review");
});

exports.verify = asyncHandler(async (req, res) => {
  const profile = await clinicPortalService.reviewClinic(req.params.id, req.body);
  return ok(res, serializeClinicProfile(profile), "Verification decision saved");
});

exports.setActive = asyncHandler(async (req, res) => {
  const profile = await clinicPortalService.setActive(req.params.id, req.body.isActive);
  return ok(
    res,
    serializeClinicProfile(profile),
    req.body.isActive ? "Clinic reinstated" : "Clinic suspended"
  );
});
