/**
 * Joi schemas for the treatment timeline (docs/treatment-timeline). Run through
 * `validateQuery`, not `validate`: Express 5 makes `req.query` a getter with no
 * setter, so the coerced result is published on `req.validatedQuery`.
 */
const Joi = require("joi");

/**
 * `month` without `year` is allowed on purpose — "every March, any year" is a
 * legitimate question to ask of a treatment history.
 */
const listTimeline = Joi.object({
  year: Joi.number().integer().min(2000).max(2100),
  month: Joi.number().integer().min(1).max(12),
  sort: Joi.string().valid("newest", "oldest").default("newest"),
});

/** The doctor's manual My-Patients status override (migration 023). */
const setPatientStatus = Joi.object({
  status: Joi.string()
    .valid("new_patient", "opd_followup", "surgery_pending", "surgery_followup")
    .required(),
});

/** My Patients roster: optional search / sort / server-side pages (none → the legacy full list). */
const listPatients = Joi.object({
  q: Joi.string().trim().max(100).allow(""),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sort: Joi.string().valid("recent", "oldest", "name", "visits").default("recent"),
  status: Joi.string().valid("new_patient", "opd_followup", "surgery_pending", "surgery_followup"),
});

module.exports = { listTimeline, setPatientStatus, listPatients };
