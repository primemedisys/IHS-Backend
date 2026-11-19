/**
 * Clinic-portal auth. A separate controller from the public one so the portal's
 * allowed roles are fixed HERE, by the route, and can never be influenced by
 * the request body.
 *
 * Unlike the admin console, a clinic CAN self-register — but signing up grants
 * an account and nothing else: `verification_status` starts 'pending' and every
 * patient route is gated behind `requireApprovedClinic`.
 */
const authService = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");
const { ROLES } = require("../config/constants");

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginClinic(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Clinic logged in");
});

/**
 * Google sign-in / signup for the clinic portal.
 *
 * `signupRole` is pinned to `clinic`: a brand-new Google account created from
 * this button is always a clinic, regardless of what the client sends. And
 * `allowedRoles` means an EXISTING doctor/patient/admin pressing it is rejected
 * with WRONG_PORTAL rather than handed a clinic-portal session.
 */
exports.google = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.googleAuth(req.body, req, {
    allowedRoles: [ROLES.CLINIC],
    signupRole: ROLES.CLINIC,
  });
  return ok(res, { user: serializeUser(user), tokens }, "Logged in with Google");
});
