/**
 * Query schemas for Doctor Dashboard 2.0 analytics (GET only → validateQuery).
 * `from` / `to` are IST calendar days (inclusive). `stripUnknown` deletes any
 * appended `doctorId` — the route pins the doctor to the signed-in user.
 * The 366-day / 92-daily-points caps live in the service (they constrain the
 * combination of fields).
 */
const Joi = require("joi");
const { BOOKING_STATUS, PAYMENT_STATUS } = require("../config/constants");

const DAY = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message("must be a date (YYYY-MM-DD)");
const range = {
  from: DAY,
  to: DAY,
  granularity: Joi.string().valid("day", "week", "month"),
};
const paging = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

const rangeQuery = Joi.object(range);

const patientsQuery = Joi.object({
  ...range,
  ...paging,
  segment: Joi.string().valid("all", "new", "returning").default("all"),
  search: Joi.string().trim().max(100).allow(""),
});

const appointmentsQuery = Joi.object({
  ...range,
  ...paging,
  status: Joi.string().valid(...Object.values(BOOKING_STATUS)),
  mode: Joi.string().valid("clinic", "video"),
});

const financialQuery = Joi.object({
  ...range,
  ...paging,
  method: Joi.string().valid("online", "cash", "upi"),
  status: Joi.string().valid(...Object.values(PAYMENT_STATUS)),
});

module.exports = { rangeQuery, patientsQuery, appointmentsQuery, financialQuery };
