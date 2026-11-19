/**
 * The approval gate on every blood-bank OPERATIONAL route (donors, units,
 * requests, camps …) — the blood-bank twin of requireApprovedClinic.
 *
 * A blood bank self-registers, so registration grants an account and nothing
 * more: until an admin approves it, it cannot hold inventory, see patient
 * requests or appear in patient search. Deliberately NOT applied to the
 * profile routes, so a pending centre can complete its details.
 *
 * Also enforces is_active (suspension). Sets `req.bloodBankId` (= users.id),
 * which every blood-bank service uses to scope its queries.
 */
const { BloodBankProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");
const { BLOOD_BANK_VERIFICATION } = require("../config/bloodBank");

module.exports = async (req, _res, next) => {
  const profile = await BloodBankProfile.findByPk(req.user.id, {
    attributes: ["userId", "verificationStatus", "verificationNotes", "isActive"],
  });
  if (!profile) {
    return next(
      new ApiError(403, "Complete your blood bank profile first.", {
        code: ERROR_CODES.ONBOARDING_INCOMPLETE,
        details: { verificationStatus: BLOOD_BANK_VERIFICATION.PENDING },
      })
    );
  }
  if (profile.verificationStatus !== BLOOD_BANK_VERIFICATION.APPROVED) {
    const rejected = profile.verificationStatus === BLOOD_BANK_VERIFICATION.REJECTED;
    const message = rejected
      ? `Your blood bank's verification was declined${profile.verificationNotes ? `: ${profile.verificationNotes}` : "."}`
      : "Your blood bank is awaiting verification by our team.";
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
  if (!profile.isActive) return next(ApiError.forbidden("This blood bank account has been suspended."));

  req.bloodBankId = req.user.id;
  return next();
};
