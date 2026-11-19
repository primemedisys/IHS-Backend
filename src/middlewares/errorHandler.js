/**
 * The single exit point for every error. Mounted LAST in app.js. It maps:
 *   - ApiError            → its own statusCode/code/details
 *   - Sequelize unique    → 409 with the offending field
 *   - Sequelize validation→ 422 with field details
 *   - anything else       → 500 (stack logged server-side, hidden from client)
 *
 * Response shape is always: { error: { message, code?, details? } }
 * (matches the frontend's error interceptor).
 */
const { ValidationError, UniqueConstraintError } = require("sequelize");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");
const env = require("../config/env");

/** 404 for any route that didn't match — forwarded into the handler below. */
function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
function errorHandler(err, _req, res, _next) {
  let status = 500;
  let body = { message: "Something went wrong", code: ERROR_CODES.INTERNAL };

  if (err instanceof ApiError) {
    status = err.statusCode;
    body = { message: err.message, code: err.code, details: err.details };
  } else if (err instanceof UniqueConstraintError) {
    status = 409;
    const field = err.errors?.[0]?.path;
    body = {
      message: `${field ?? "Value"} is already in use`,
      code: ERROR_CODES.EMAIL_IN_USE,
    };
  } else if (err instanceof ValidationError) {
    status = 422;
    const details = {};
    for (const e of err.errors) (details[e.path] ||= []).push(e.message);
    body = { message: "Validation failed", code: ERROR_CODES.VALIDATION_ERROR, details };
  }

  // Log unexpected (non-operational) errors with their stack for debugging.
  if (status >= 500) {
    console.error("[error]", err);
    if (env.NODE_ENV !== "production") body.stack = err.stack;
  }

  // Drop undefined keys so the envelope stays clean.
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  res.status(status).json({ error: body });
}

module.exports = { notFound, errorHandler };
