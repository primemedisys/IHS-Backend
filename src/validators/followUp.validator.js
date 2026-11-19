/**
 * Joi schemas for doctor-defined follow-up statuses (docs/follow-up-status).
 *
 * The LABEL is free text on purpose — the doctor invents their own vocabulary,
 * so there is no enum to validate against and no server-side opinion about
 * which words are allowed.
 */
const Joi = require("joi");
const { FOLLOW_UP_INTERVAL_UNITS } = require("../config/constants");

/** "#RRGGBB". Six digits only — three-digit shorthand would break CHAR(7). */
const colorHex = Joi.string()
  .pattern(/^#[0-9A-Fa-f]{6}$/)
  .message("Colour must be a hex value like #2E86C1");

const createStatus = Joi.object({
  label: Joi.string().trim().min(2).max(40).required(),
  colorHex: colorHex.required(),
  sortOrder: Joi.number().integer().min(0).max(999),
});

/** Every field optional — this is the rename/recolour/reorder/archive endpoint. */
const updateStatus = Joi.object({
  label: Joi.string().trim().min(2).max(40),
  colorHex,
  sortOrder: Joi.number().integer().min(0).max(999),
  isActive: Joi.boolean(),
}).min(1);

const reorderStatuses = Joi.object({
  ids: Joi.array().items(Joi.string().required()).min(1).required(),
});

/**
 * `followUpOn` has NO `.min("now")`: a doctor may back-date a follow-up they
 * are recording after the fact, and refusing that would push them to enter a
 * wrong date instead of the real one.
 */
const setFollowUp = Joi.object({
  statusId: Joi.string().required(),
  followUpOn: Joi.date().iso().allow(null),
  note: Joi.string().trim().max(140).allow("", null),
  bookingId: Joi.string().allow(null),
  // EMR follow-up plan (migration 051). All optional; omitted fields keep
  // their stored value, so the older status/date/note-only clients are unchanged.
  intervalValue: Joi.number().integer().min(1).max(365).allow(null),
  intervalUnit: Joi.string().valid(...FOLLOW_UP_INTERVAL_UNITS).allow(null),
  homeCare: Joi.boolean(),
  serviceName: Joi.string().trim().max(150).allow("", null),
  serviceQuantity: Joi.number().integer().min(1).max(999).allow(null),
  comments: Joi.string().trim().max(1000).allow("", null),
}).and("intervalValue", "intervalUnit");

module.exports = { createStatus, updateStatus, reorderStatuses, setFollowUp };
