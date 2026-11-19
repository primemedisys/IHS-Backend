/**
 * Role gate. Must run AFTER `authenticate` (it reads `req.user.role`).
 *
 *   router.get("/admin/stats", authenticate, authorize("admin"), handler)
 *
 * @param {...string} roles  roles allowed through (see config/constants ROLES)
 */
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

module.exports = (...roles) => (req, _res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized("Not authenticated", { code: ERROR_CODES.UNAUTHENTICATED }));
  }
  if (!roles.includes(req.user.role)) {
    return next(
      ApiError.forbidden("You do not have access to this resource", {
        code: ERROR_CODES.FORBIDDEN,
      })
    );
  }
  return next();
};
