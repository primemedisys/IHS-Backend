/**
 * The approval gate on every clinic route that touches PATIENT data.
 *
 * A clinic self-registers, so without this anyone with an email address could
 * sign up and immediately read every registered patient's records. Registration
 * therefore grants an account and nothing more: the directory and the patient
 * workspace stay closed until an admin approves the clinic.
 *
 * Deliberately NOT applied to `/clinic/profile`, `/clinic/onboarding`,
 * `/clinic/submit` or `/clinic/documents` — a pending clinic must be able to
 * finish onboarding, which is the whole point of the pending state.
 *
 * Also enforces `is_active`, so an approved clinic can be suspended without
 * being rejected (its history and account survive; its access stops).
 */
const { ClinicProfile, User } = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

module.exports = async (req, _res, next) => {
  let profile = await ClinicProfile.findByPk(req.user.id, {
    attributes: ["userId", "verificationStatus", "verificationNotes", "isActive"],
  });

  // Defensive: auto-create the profile row if it's missing.
  if (!profile) {
    const user = await User.findByPk(req.user.id, { attributes: ["id", "name", "phone"] });
    if (user) {
      await ClinicProfile.create({ userId: user.id, clinicName: user.name, phone: user.phone || null });
      profile = await ClinicProfile.findByPk(req.user.id, {
        attributes: ["userId", "verificationStatus", "verificationNotes", "isActive"],
      });
    }
  }

  if (!profile) {
    return next(ApiError.notFound("Clinic profile not found"));
  }
  if (profile.verificationStatus !== "approved") {
    // A REJECTED clinic must not be told it is "awaiting verification" — it is
    // waiting on nobody, and the reason it was declined is the one thing that
    // would let it fix the problem and resubmit.
    const rejected = profile.verificationStatus === "rejected";
    const message = rejected
      ? profile.verificationNotes
        ? `Your clinic's verification was declined: ${profile.verificationNotes}`
        : "Your clinic's verification was declined. Please review your details and submit again."
      : "Your clinic is awaiting verification by our team.";

    return next(
      new ApiError(403, message, {
        code: ERROR_CODES.ONBOARDING_INCOMPLETE,
        details: {
          verificationStatus: profile.verificationStatus,
          verificationNotes: profile.verificationNotes ?? null,
        },
      })
    );
  }
  if (!profile.isActive) {
    return next(ApiError.forbidden("This clinic account has been suspended."));
  }

  // Downstream services stamp provenance with this — it is the clinic's users.id.
  req.clinicId = req.user.id;
  return next();
};
