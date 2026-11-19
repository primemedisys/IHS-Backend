/**
 * Auth controllers — deliberately THIN. Each handler:
 *   1. reads already-validated input from req (validation happened in middleware),
 *   2. calls exactly one auth.service function,
 *   3. serializes and returns through an apiResponse helper.
 * No business rules, no DB calls, no validation logic live here.
 */
const authService = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created, raw } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");
const { ROLES } = require("../config/constants");

exports.register = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.registerLocal(req.body, req);
  return created(res, { user: serializeUser(user), tokens }, "Registered successfully");
});

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginLocal(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Logged in");
});

// The public Google button belongs to the patient/doctor apps. The allowed
// roles are fixed HERE, by the route — never taken from the request body, which
// a caller could simply omit.
exports.google = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.googleAuth(req.body, req, {
    allowedRoles: [ROLES.DOCTOR, ROLES.PATIENT],
  });
  return ok(res, { user: serializeUser(user), tokens }, "Logged in with Google");
});

exports.refresh = asyncHandler(async (req, res) => {
  const { tokens } = await authService.refresh(req.body.refreshToken, req);
  // Frontend reads the pair directly from `data.data` on this route → use raw().
  return raw(res, tokens);
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body);
  // Always the same response — no user enumeration.
  return ok(res, null, "If that email exists, a reset link has been sent");
});

exports.requestPasswordOtp = asyncHandler(async (req, res) => {
  await authService.requestPasswordOtp(req.body);
  // Same answer whether or not the number is registered — no enumeration.
  return ok(res, null, "If that mobile number is registered, a verification code has been sent");
});

exports.verifyPasswordOtp = asyncHandler(async (req, res) => {
  const data = await authService.verifyPasswordOtp(req.body);
  return ok(res, data, "Code verified");
});

exports.resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  return ok(res, null, "Password has been reset");
});

exports.changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.id, req.body);
  return ok(res, null, "Password changed");
});

exports.me = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id, req.user.role);
  return ok(res, serializeUser(user), "Current user");
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const user = await authService.updateProfile(req.user.id, req.user.role, req.body);
  return ok(res, serializeUser(user), "Profile updated");
});

exports.logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  return ok(res, null, "Logged out");
});
