/**
 * Joi schemas for the public (no-auth) doctor reads. Run through the
 * `validateQuery` middleware, which publishes the coerced value on
 * `req.validatedQuery` (Express 5 forbids reassigning `req.query`).
 */
const Joi = require("joi");
const { DOCTOR_SORTS, DOCTOR_PAGE_SIZE_DEFAULT, DOCTOR_PAGE_SIZE_MAX } = require("../config/constants");

/**
 * Discovery filters. Mirrors the frontend `DoctorFilters` type
 * (frontend-patient/src/types/doctor.ts) key for key — every key it can send is
 * either honoured or explicitly accepted-and-ignored, so a filter can never be
 * silently dropped again.
 *
 * `lat`/`lng` are bound together by `.and()`: `sort=nearest` needs both to
 * order by distance, and half a coordinate is always a client bug.
 */
const listDoctors = Joi.object({
  search: Joi.string().trim().allow("").max(150),
  specialtySlug: Joi.string().trim().max(120),
  // A catalog sub-specialty slug (GET /sub-specializations). Matches doctors
  // tagged with it via doctor_sub_specializations; combines with specialtySlug.
  subSpecialtySlug: Joi.string().trim().max(150),
  // Comma-separated doctor (user) ids to leave out — the patient app's "Other
  // doctors" tab excludes the patient's own doctors server-side, so paging and
  // totals stay exact. Coerced to an array of positive ints.
  excludeIds: Joi.string()
    .trim()
    .pattern(/^\d+(,\d+){0,199}$/)
    .custom((v) => [...new Set(v.split(",").map(Number))].filter((n) => n > 0)),
  // The opposite: ONLY these doctor ids — the patient app's "My doctors" tab
  // runs the same search/filters over just the doctors the patient has booked.
  includeIds: Joi.string()
    .trim()
    .pattern(/^\d+(,\d+){0,199}$/)
    .custom((v) => [...new Set(v.split(",").map(Number))].filter((n) => n > 0)),
  symptomSlug: Joi.string().trim().max(150),
  stateCode: Joi.string().trim().max(100),
  city: Joi.string().trim().max(100),
  hospital: Joi.string().trim().max(150),
  gender: Joi.string().valid("male", "female", "other"),
  language: Joi.string().trim().max(100),
  minExperience: Joi.number().integer().min(0).max(100),
  maxFee: Joi.number().min(0),
  minRating: Joi.number().min(0).max(5),
  videoConsult: Joi.boolean(),
  // Accepted for frontend compatibility, then ignored: the public list is
  // approved-only (so `verified` is always true) and the serializer hardcodes
  // `available: true`. Declared here so `stripUnknown` doesn't 422 on them.
  verified: Joi.boolean(),
  available: Joi.boolean(),
  sort: Joi.string()
    .valid(...DOCTOR_SORTS)
    .default("relevance"),
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number()
    .integer()
    .min(1)
    .max(DOCTOR_PAGE_SIZE_MAX)
    .default(DOCTOR_PAGE_SIZE_DEFAULT),
}).and("lat", "lng");

/** `/doctors/:id/…` — a numeric doctor (user) id, never a slug. */
const doctorIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

module.exports = { listDoctors, doctorIdParam };
