/**
 * Query-string validation for Express 5.
 *
 * The sibling `validate()` middleware finishes by reassigning `req[property]`.
 * That works for `body` and `params`, but in Express 5 `req.query` is a lazy
 * GETTER with no setter — assigning to it throws. That is why the public reads
 * historically skipped validation and normalized the query by hand inside the
 * service, which put request-shape checking in the wrong layer.
 *
 * This middleware validates the same way (abortEarly:false, stripUnknown,
 * convert) but publishes the coerced result on `req.validatedQuery`, leaving
 * `req.query` untouched. Controllers read `req.validatedQuery` and can trust it
 * completely — no normalization in services.
 *
 *   router.get("/doctors", validateQuery(schema.listDoctors), controller.list)
 */
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

module.exports = (schema) => (req, _res, next) => {
  const { value, error } = schema.validate(req.query, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    const details = {};
    for (const d of error.details) {
      const key = d.path.join(".") || "_";
      (details[key] ||= []).push(d.message.replace(/"/g, ""));
    }
    return next(
      new ApiError(422, "Validation failed", { code: ERROR_CODES.VALIDATION_ERROR, details })
    );
  }

  req.validatedQuery = value;
  return next();
};
