/**
 * Joi schema for the public contact form (POST /contact). Mirrors the frontend
 * `contactSchema` (frontend-patient/src/features/contact/schemas) so the two
 * can't drift: name ≥ 2, valid email, optional phone, message ≥ 20 chars.
 */
const Joi = require("joi");

const createMessage = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  email: Joi.string().trim().lowercase().email().max(255).required(),
  // Optional — the form lets a visitor omit it (or send ""). Kept lenient: this
  // is a public form, not an account field, so we don't enforce a phone format.
  phone: Joi.string().trim().max(30).allow("").optional(),
  message: Joi.string().trim().min(20).max(5000).required(),
});

/** Admin inbox list query (paginated; optional `handled` filter). */
const listMessages = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  handled: Joi.boolean(),
});

/** Admin flips the followed-up flag. */
const updateMessage = Joi.object({
  handled: Joi.boolean().required(),
});

module.exports = { createMessage, listMessages, updateMessage };
