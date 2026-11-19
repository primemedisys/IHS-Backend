/**
 * Normalizes "which patient is this clinic request about" into `req.patientId`,
 * 404ing early unless `:patientId` is a real, active patient account.
 *
 * Mirrors resolveDoctorId: every downstream service call is then guaranteed a
 * real patient, exactly as the token guarantees ownership on a `/patient/*`
 * route.
 *
 * Existence-only BY DESIGN — an approved clinic may open any registered patient,
 * which is the product decision behind the directory. Building it as middleware
 * means the future "clinic ↔ patient must be linked" phase has exactly ONE
 * place to tighten, rather than a rule copied across a dozen handlers.
 */
const { User } = require("../models");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");

module.exports = async (req, _res, next) => {
  const id = req.params.patientId;
  const patient = await User.findByPk(id, { attributes: ["id", "role", "isActive"] });
  if (!patient || patient.role !== ROLES.PATIENT || !patient.isActive) {
    return next(ApiError.notFound("Patient not found"));
  }
  req.patientId = patient.id;
  return next();
};
