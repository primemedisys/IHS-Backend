/**
 * Turns a Joi schema into request-validation middleware. This is what keeps
 * validation OUT of controllers: a route declares `validate(schema)` and the
 * controller can trust `req.body` completely.
 *
 * On success it REPLACES `req.body` with the coerced/stripped value (so
 * defaults, trimming, lowercasing and type coercion are applied downstream).
 * On failure it throws a 422 ApiError carrying field-level details, which the
 * central error handler renders.
 *
 *   router.post("/login", validate(loginSchema), controller.login)
 */
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

/**
 * @param {import('joi').Schema} schema
 * @param {"body"|"query"|"params"} [property="body"]
 */
module.exports = (schema, property = "body") => (req, _res, next) => {
  const { value, error } = schema.validate(req[property], {
    abortEarly: false, // collect ALL errors, not just the first
    stripUnknown: true, // drop keys the schema doesn't mention
    convert: true, // coerce "12" → 12, trim strings, apply defaults
  });

  if (error) {
    // Group messages by field for the frontend's `errors: Record<field, string[]>`.
    const details = {};
    for (const d of error.details) {
      const key = d.path.join(".") || "_";
      (details[key] ||= []).push(d.message.replace(/"/g, ""));
    }
    return next(
      new ApiError(422, "Validation failed", { code: ERROR_CODES.VALIDATION_ERROR, details })
    );
  }

  req[property] = value;
  return next();
};
