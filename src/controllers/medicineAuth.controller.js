/**
 * Medicine-portal auth. Separate controller so the allowed roles are fixed
 * HERE, by the route, and can never be influenced by the request body.
 *
 * Pharmacies self-register as 'medicine_store' (Pharmacy Medicine Store /
 * Clinic) or 'pharmacy_hospital' and are usable immediately — there is no
 * verification gate like the clinic portal's. The retired 'mr' role can still
 * SIGN IN (its accounts and data are intact) but can no longer be created.
 *
 * The Diagnostic Lab Center ('diagnostic_lab', migration 038) signs in through
 * this same portal; it is kept out of every medicine route by authorization.
 */
const authService = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");
const { PROVIDER_PORTAL_ROLES } = require("../config/constants");

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginMedicineProvider(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Logged in");
});

exports.google = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.googleAuth(req.body, req, {
    allowedRoles: [...PROVIDER_PORTAL_ROLES],
  });
  return ok(res, { user: serializeUser(user), tokens }, "Logged in with Google");
});
