/**
 * Normalizes "which doctor is this request about" into `req.doctorId`, so the
 * SAME doctor/clinic controllers serve both the owner (`/doctor/*`, id from the
 * token) and an admin acting on a target (`/admin/doctors/:doctorId/*`, id from
 * the URL). This is what lets the admin surface reuse the doctor services with
 * zero duplicated business logic (docs/admin-portal/backend-plan.md §3).
 *
 *   source = "self"  → req.doctorId = req.user.id
 *   source = "param" → req.doctorId = req.params.doctorId  (404 if unknown)
 *
 * Param mode 404s an unknown doctor early, so every downstream service call is
 * guaranteed a real profile (mirrors the ownership guarantee the token gives the
 * self path).
 */
const { DoctorProfile } = require("../models");
const ApiError = require("../utils/ApiError");

module.exports = (source) => async (req, _res, next) => {
  if (source === "self") {
    req.doctorId = req.user.id;
    return next();
  }

  // source === "param"
  const id = req.params.doctorId;
  const exists = await DoctorProfile.findByPk(id, { attributes: ["userId"] });
  if (!exists) return next(ApiError.notFound("Doctor not found"));
  req.doctorId = id;
  return next();
};
