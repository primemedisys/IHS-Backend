/**
 * Verifies the `Authorization: Bearer <access>` JWT and attaches a minimal
 * `req.user = { id, role, email }`. Normal authenticated requests do NOT hit
 * the database — the access token is self-contained. Sensitive actions that
 * need the live `is_active` flag re-load the user themselves.
 */
const { verifyAccessToken } = require("../utils/accessToken");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

module.exports = (req, _res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(
      ApiError.unauthorized("Missing or malformed Authorization header", {
        code: ERROR_CODES.UNAUTHENTICATED,
      })
    );
  }

  try {
    const { id, role, email } = verifyAccessToken(token);
    req.user = { id, role, email };
    return next();
  } catch {
    return next(
      ApiError.unauthorized("Invalid or expired access token", {
        code: ERROR_CODES.TOKEN_INVALID,
      })
    );
  }
};
