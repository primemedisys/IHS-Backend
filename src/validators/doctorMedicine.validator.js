/**
 * Joi schemas for the doctor medicine master list (CRUD).
 */
const Joi = require("joi");
const { MEDICINE_FORMS, MEDICINE_TYPES, MEDICINE_TIMINGS } = require("../config/constants");

const SAFE = (max) => Joi.string().trim().max(max);
const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));

const createMedicine = Joi.object({
  name: SAFE(200).required(),
  // Migration 055 — descriptive fields + the catalogue row picked, if any.
  genericName: SAFE(255).allow("", null).default(null),
  manufacturer: SAFE(255).allow("", null).default(null),
  description: SAFE(2000).allow("", null).default(null),
  medicineMasterId: ID.allow(null),
  form: Joi.string().valid(...MEDICINE_FORMS).default("oral"),
  strength: SAFE(100).allow("", null).default(null),
  dosageForm: Joi.string().valid(...MEDICINE_TYPES).allow(null).default(null),
  // Default instructions (migration 054) — same rules as a prescription line's
  // frequency / timing. Optional: older clients and older rows simply omit them.
  defaultFrequency: SAFE(100).allow("", null).default(null),
  defaultTiming: Joi.string().valid(...MEDICINE_TIMINGS).allow(null).default(null),
  // Still accepted (older clients), no longer asked for in the doctor UI.
  category: SAFE(100).allow("", null).default(null),
});

const updateMedicine = Joi.object({
  name: SAFE(200),
  genericName: SAFE(255).allow("", null),
  manufacturer: SAFE(255).allow("", null),
  description: SAFE(2000).allow("", null),
  medicineMasterId: ID.allow(null),
  form: Joi.string().valid(...MEDICINE_FORMS),
  strength: SAFE(100).allow("", null),
  dosageForm: Joi.string().valid(...MEDICINE_TYPES).allow(null),
  defaultFrequency: SAFE(100).allow("", null),
  defaultTiming: Joi.string().valid(...MEDICINE_TIMINGS).allow(null),
  category: SAFE(100).allow("", null),
  isActive: Joi.boolean(),
}).min(1);

const listMedicines = Joi.object({
  search: SAFE(100).allow("", null),
  category: SAFE(100).allow("", null),
  form: Joi.string().valid(...MEDICINE_FORMS),
});

module.exports = {
  createMedicine,
  updateMedicine,
  listMedicines,
};
