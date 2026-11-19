/**
 * Admin-only auth. Separate controller so the admin surface stays isolated from
 * the public one, even though it shares the same login body shape.
 */
const authService = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginAdmin(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Admin logged in");
});
