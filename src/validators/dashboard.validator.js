/**
 * Query schemas for the dashboard/earnings reads (docs/dashboards-earnings §6.1).
 *
 * Every endpoint here is a GET, so these run through `middlewares/validateQuery`
 * — NOT `validate(schema, "query")`. Express 5 exposes `req.query` as a lazy
 * getter with no setter, so `validate()`'s closing `req[property] = value` would
 * throw. `validateQuery` publishes the coerced result on `req.validatedQuery`.
 *
 * `stripUnknown` is what stops a doctor appending `?doctorId=<someone-else>`:
 * the key is deleted before the controller ever sees it.
 */
const Joi = require("joi");
const {
  SERIES_GRANULARITY,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
  ADMIN_TOP_DOCTORS_LIMIT,
} = require("../config/constants");

// `.greater(from)` rejects an inverted range at the edge. Without it the query
// runs, returns nothing, and the chart renders an empty axis that reads as
// "no earnings" rather than "you asked for a backwards range".
const from = Joi.date().iso().optional();
const to = Joi.date().iso().optional().greater(Joi.ref("from"));
const granularity = Joi.string()
  .valid(...SERIES_GRANULARITY)
  .default("month");

// NOTE: the `day`-granularity width cap is NOT here. It constrains the
// COMBINATION of from + to + granularity, which a field-at-a-time schema can't
// express — `utils/period.resolveRange` enforces it and throws a 400.
const summary = Joi.object({ from, to });
const series = Joi.object({ from, to, granularity });

const transactions = Joi.object({
  from,
  to,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(LEDGER_PAGE_SIZE_MAX).default(LEDGER_PAGE_SIZE_DEFAULT),
});

const topDoctors = Joi.object({
  from,
  to,
  limit: Joi.number().integer().min(1).max(20).default(ADMIN_TOP_DOCTORS_LIMIT),
});

module.exports = { summary, series, transactions, topDoctors };
