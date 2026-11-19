/**
 * Admin doctor-management business logic. The verification queue + verdict live
 * in `verification.service`; this file adds the one genuinely new admin behaviour
 * — creating a doctor that is LIVE immediately (docs/admin-portal §6). All the
 * *editing* of that doctor reuses `doctor.service` via the shared controllers.
 */
const { sequelize, User } = require("../models");
const password = require("../utils/password");
const ApiError = require("../utils/ApiError");
const { ROLES, AUTH_PROVIDERS, ERROR_CODES } = require("../config/constants");
const userService = require("./user.service");
const doctorService = require("./doctor.service");

/**
 * Admin creates a doctor that skips verification: verification_status='approved'
 * + is_submitted=true, so the doctor is public from creation (the public read
 * path already gates on ='approved'). User + profile row are created atomically.
 */
async function createDoctor({ name, email, password: plain }) {
  const existing = await userService.findByEmail(email);
  if (existing) {
    throw ApiError.conflict("Email is already registered", { code: ERROR_CODES.EMAIL_IN_USE });
  }

  const passwordHash = await password.hash(plain);

  const user = await sequelize.transaction(async (tx) => {
    const created = await User.create(
      {
        name,
        email,
        passwordHash,
        role: ROLES.DOCTOR,
        authProvider: AUTH_PROVIDERS.LOCAL,
        isEmailVerified: true, // admin-vouched
      },
      { transaction: tx }
    );
    // Reuse the shared profile-row helper (keeps the PENDING-<id> reg-number rule
    // in ONE place) and override the review state to approved/submitted.
    await userService.createProfileRow(created, tx, {
      verificationStatus: "approved",
      isSubmitted: true,
    });
    return created;
  });

  // Return the full admin-profile shape so the UI drops straight into the builder.
  return doctorService.getOwnProfile(user.id);
}

module.exports = { createDoctor };
