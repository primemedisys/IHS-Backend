/**
 * Joi schemas for automatic follow-up reminders (docs/follow-up-reminders-07-09-2026).
 *
 * The doctor provides EITHER `reminderDaysBefore` (system computes the DATETIME)
 * OR `reminderAt` (explicit datetime). At least one must be present.
 */
const Joi = require("joi");

const setReminder = Joi.object({
  reminderDaysBefore: Joi.number().integer().min(1).max(90).allow(null),
  reminderAt: Joi.date().iso().allow(null),
  channel: Joi.string().valid("email", "whatsapp", "both").allow(null),
}).min(1).messages({
  "object.min": "Provide at least one of reminderDaysBefore or reminderAt",
});

const toggleWhatsAppOptIn = Joi.object({
  whatsappOptIn: Joi.boolean().required(),
});

module.exports = { setReminder, toggleWhatsAppOptIn };
