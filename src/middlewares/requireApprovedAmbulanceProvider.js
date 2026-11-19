/**
 * The approval gate on every ambulance-provider OPERATIONAL route (dashboard,
 * ambulances, drivers, bookings) — the ambulance twin of
 * requireApprovedBloodBank.
 *
 * A provider self-registers, so registration grants an account and nothing
 * more: until an admin approves it, it cannot operate, receive bookings or
 * appear in public search. Deliberately NOT applied to the profile routes, so
 * a pending provider can complete (and, after a rejection, correct) its details.
 *
 * Also enforces is_active (suspension). Sets `req.providerId` (= users.id),
 * which every ambulance service uses to scope its queries.
 */
const { AmbulanceProviderProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");
const { AMBULANCE_VERIFICATION } = require("../config/ambulance");

module.exports = async (req, _res, next) => {
  const profile = await AmbulanceProviderProfile.findByPk(req.user.id, {
    attributes: ["userId", "verificationStatus", "verificationNotes", "isActive"],
  });
  if (!profile) {
    return next(
      new ApiError(403, "Complete your ambulance provider profile first.", {
        code: ERROR_CODES.ONBOARDING_INCOMPLETE,
        details: { verificationStatus: AMBULANCE_VERIFICATION.PENDING },
      })
    );
  }
  if (profile.verificationStatus !== AMBULANCE_VERIFICATION.APPROVED) {
    const rejected = profile.verificationStatus === AMBULANCE_VERIFICATION.REJECTED;
    const message = rejected
      ? `Your provider verification was declined${profile.verificationNotes ? `: ${profile.verificationNotes}` : "."}`
      : "Your ambulance service is awaiting verification by our team.";
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
  if (!profile.isActive) return next(ApiError.forbidden("This ambulance provider account has been suspended."));

  req.providerId = req.user.id;
  return next();
};
