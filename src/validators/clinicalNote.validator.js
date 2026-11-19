/**
 * Joi schema for creating a clinical note. Every field is optional (free text +
 * vitals), but the note must carry at least one detail — an empty note is
 * meaningless. Notes are append-only, so there is no update schema.
 */
const Joi = require("joi");

const text = Joi.string().trim().max(4000).allow("", null);

const TEXT_FIELDS = ["complaints", "onExamination", "historyMedical", "historySurgical", "diagnosis", "treatment"];
const VITAL_FIELDS = ["bloodPressure", "pulseRateBpm", "weightKg", "heightCm", "temperatureF", "spo2Percent"];

const vitals = Joi.object({
  bloodPressure: Joi.string().trim().max(20).allow("", null),
  pulseRateBpm: Joi.number().integer().min(0).max(400).allow(null),
  weightKg: Joi.number().min(0).max(1000).allow(null),
  heightCm: Joi.number().min(0).max(300).allow(null),
  temperatureF: Joi.number().min(0).max(120).allow(null),
  spo2Percent: Joi.number().integer().min(0).max(100).allow(null),
}).default({});

const createNote = Joi.object({
  complaints: text, // c/o
  onExamination: text, // o/e
  historyMedical: text, // h/o medical
  historySurgical: text, // h/o surgical
  diagnosis: text,
  treatment: text,
  vitals,
}).custom((value, helpers) => {
  const hasText = TEXT_FIELDS.some((k) => typeof value[k] === "string" && value[k].trim() !== "");
  const v = value.vitals || {};
  const hasVital = VITAL_FIELDS.some((k) => {
    const x = v[k];
    return typeof x === "number" || (typeof x === "string" && x.trim() !== "");
  });
  if (!hasText && !hasVital) return helpers.message("Add at least one detail before saving the note.");
  return value;
}, "at least one field");

module.exports = { createNote };
