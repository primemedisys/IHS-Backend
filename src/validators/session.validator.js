/**
 * Joi schemas for the consultation-queue endpoints (docs/consultation-queue).
 * Shape only — whether a session exists, whether it is full and whether the
 * doctor owns it are business rules in session.service.
 */
const Joi = require("joi");
const { SESSION_HORIZON_DAYS, SESSION_HORIZON_MAX_DAYS } = require("../config/constants");

/** The public session list: which days a doctor is consulting, and where. */
const sessionQuery = Joi.object({
  mode: Joi.string().valid("clinic", "online").required(),
  clinicId: Joi.number()
    .integer()
    .positive()
    .when("mode", { is: "clinic", then: Joi.required(), otherwise: Joi.forbidden() }),
  // Defaults to today → +30 days. The service caps the span at
  // SESSION_HORIZON_MAX_DAYS so one request can never expand a year of
  // templates.
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  days: Joi.number().integer().min(1).max(SESSION_HORIZON_MAX_DAYS).default(SESSION_HORIZON_DAYS),
});

/** The doctor's own console, one day at a time. */
const doctorSessionQuery = Joi.object({
  date: Joi.date().iso().optional(),
});

/**
 * Cap today's list without touching the weekly template. `null` clears it, which
 * is how a doctor re-opens a day they had closed.
 */
const setSessionCap = Joi.object({
  maxBookings: Joi.number().integer().min(1).max(500).allow(null).required(),
});

/** Why a patient was moved aside — optional, and never shown to them. */
const skipBooking = Joi.object({
  reason: Joi.string().trim().max(255).allow("", null).default(null),
});

module.exports = { sessionQuery, doctorSessionQuery, setSessionCap, skipBooking };
