/**
 * A typed operational error. Anything the app throws on purpose (bad creds,
 * duplicate email, missing resource) is an ApiError carrying the HTTP status,
 * a stable machine code, and optional field-level details. The central error
 * handler knows how to turn these into a clean JSON envelope; anything that is
 * NOT an ApiError is treated as an unexpected 500 and its stack is hidden in
 * production.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode  HTTP status (e.g. 401, 409)
   * @param {string} message     human-readable message
   * @param {object} [options]
   * @param {string} [options.code]     stable machine code (see ERROR_CODES)
   * @param {object} [options.details]  field-level details, e.g. { email: ["taken"] }
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // distinguishes "expected" errors from bugs
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg, opts) {
    return new ApiError(400, msg, opts);
  }
  static unauthorized(msg = "Unauthenticated", opts) {
    return new ApiError(401, msg, opts);
  }
  static forbidden(msg = "Forbidden", opts) {
    return new ApiError(403, msg, opts);
  }
  static notFound(msg = "Not found", opts) {
    return new ApiError(404, msg, opts);
  }
  static conflict(msg, opts) {
    return new ApiError(409, msg, opts);
  }

  /**
   * The single canonical "bad login" error. Used by every credential check so
   * the message/code never drift and an unknown email is indistinguishable from
   * a wrong password (no user enumeration). Requires ERROR_CODES to be passed in
   * to avoid a circular require with config/constants.
   */
  static invalidCredentials(code = "INVALID_CREDENTIALS") {
    return new ApiError(401, "Invalid email or password", { code });
  }
}

module.exports = ApiError;
