/**
 * Joi schemas for the doctor EMR workspace (migration 051). Query schemas run
 * through `validateQuery` (Express 5 req.query has no setter → the result is on
 * req.validatedQuery); body schemas through `validate`.
 */
const Joi = require("joi");
const {
  CLINICAL_ENTRY_KIND: K,
  CLINICAL_ENTRY_KINDS,
  HISTORY_CATEGORIES,
  COMORBIDITY_CATEGORIES,
  EXAMINATION_FORMS,
  DIAGNOSIS_TYPES,
  INVESTIGATION_TYPES,
  ORDER_PRIORITIES,
  DOCTOR_NOTE_TYPES,
} = require("../config/constants");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const DAY = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message("must be a date like 2026-10-30");
const SAFE = (max) => Joi.string().trim().max(max);
const keys = (list) => list.map((x) => x.key);

// ── Queries ──────────────────────────────────────────────────────────────────
const workbenchQuery = Joi.object({
  date: DAY,
  view: Joi.string().valid("pending", "completed").default("pending"),
  q: SAFE(100).allow(""),
});

const workspaceQuery = Joi.object({ bookingId: ID });

const vitalsQuery = Joi.object({ from: DAY, to: DAY });

const entriesQuery = Joi.object({
  kind: Joi.string().valid(...CLINICAL_ENTRY_KINDS),
  bookingId: ID,
  includeRetired: Joi.boolean().default(false),
});

const searchQuery = Joi.object({ q: SAFE(100).min(2).required() });

const timelineQuery = Joi.object({
  types: Joi.string().valid("all", "consultations", "diagnoses", "investigations", "prescriptions", "followups").default("all"),
  doctorId: ID,
  specialty: SAFE(100),
  from: DAY,
  to: DAY,
  order: Joi.string().valid("asc", "desc").default("desc"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const auditQuery = Joi.object({
  from: DAY,
  to: DAY,
  action: Joi.string().trim().pattern(/^[a-z_]{1,50}$/),
  entityType: Joi.string().trim().pattern(/^[a-z_]{1,50}$/),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const patientParams = Joi.object({ patientId: ID.required() });
const bookingParams = Joi.object({ bookingId: ID.required() });
const visitParams = Joi.object({ patientId: ID.required(), bookingId: ID.required() });
const idParams = Joi.object({ id: ID.required() });

// ── Vitals ───────────────────────────────────────────────────────────────────
/**
 * The full EMR measurement set. Clinical bounds catch a typo (a pulse of 780)
 * before it reaches a chart; an empty field stays empty (null), never 0.
 */
const VITAL_KEYS = [
  "bpSystolic",
  "bpDiastolic",
  "pulseRateBpm",
  "heartRateBpm",
  "respiratoryRate",
  "spo2Percent",
  "temperatureF",
  "heightCm",
  "weightKg",
  "waistCm",
  "hipCm",
  "headCircumferenceCm",
];

const addVitals = Joi.object({
  recordedAt: Joi.date().iso().max("now"),
  bpSystolic: Joi.number().integer().min(50).max(300).allow(null),
  bpDiastolic: Joi.number().integer().min(20).max(200).allow(null),
  pulseRateBpm: Joi.number().integer().min(20).max(300).allow(null),
  heartRateBpm: Joi.number().integer().min(20).max(300).allow(null),
  respiratoryRate: Joi.number().integer().min(4).max(80).allow(null),
  spo2Percent: Joi.number().integer().min(50).max(100).allow(null),
  temperatureF: Joi.number().min(90).max(110).allow(null),
  heightCm: Joi.number().min(20).max(280).allow(null),
  weightKg: Joi.number().min(0.5).max(500).allow(null),
  waistCm: Joi.number().min(20).max(300).allow(null),
  hipCm: Joi.number().min(20).max(300).allow(null),
  headCircumferenceCm: Joi.number().min(20).max(80).allow(null),
  note: SAFE(255).allow("", null),
  location: SAFE(150).allow("", null),
})
  // A blood pressure is a PAIR — half of one is not a reading.
  .and("bpSystolic", "bpDiastolic")
  .messages({ "object.and": "Enter both systolic and diastolic pressure" })
  .custom((value, helpers) => {
    if (value.bpSystolic != null && value.bpDiastolic != null && value.bpDiastolic >= value.bpSystolic) {
      return helpers.message("Diastolic pressure must be lower than systolic");
    }
    if (!VITAL_KEYS.some((k) => typeof value[k] === "number")) {
      return helpers.message("Add at least one measurement before saving.");
    }
    return value;
  }, "vitals");

// ── Structured entries ───────────────────────────────────────────────────────
/** Free-text findings keyed by field name (an examination form, an HPI block…). */
const details = Joi.object()
  .pattern(Joi.string().pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), Joi.alternatives(SAFE(4000).allow(""), Joi.number(), Joi.boolean(), Joi.valid(null)))
  .max(40);

const ICD = SAFE(20).pattern(/^[A-Za-z0-9.\-]+$/).message("ICD code may use letters, digits, '.' and '-'");

const entryBase = {
  kind: Joi.string().valid(...CLINICAL_ENTRY_KINDS).required(),
  category: SAFE(60).allow(null),
  title: SAFE(255).allow("", null),
  code: ICD.allow("", null),
  details: details.allow(null),
  remarks: SAFE(10000).allow("", null),
  recordedOn: DAY.allow(null),
  patientVisible: Joi.boolean(),
  // Migration 059 — a diagnosis picked from the admin ICD catalogue. The server
  // takes the code, system, version and description from that row.
  icdCodeId: ID.allow(null),
};

const is = (kind) => Joi.object({ kind: Joi.valid(kind) }).unknown();

const createEntry = Joi.object(entryBase)
  .when(is(K.COMPLAINT), {
    then: Joi.object({
      title: SAFE(255).required().messages({ "any.required": "Enter the complaint" }),
      details: Joi.object({
        duration: Joi.number().integer().min(1).max(999).allow(null),
        durationUnit: Joi.string().valid("hour", "day", "week", "month", "year").allow(null),
        severity: Joi.string().valid("mild", "moderate", "severe").allow(null),
      }).allow(null),
    }),
  })
  .when(is(K.HISTORY), {
    then: Joi.object({ category: Joi.string().valid(...keys(HISTORY_CATEGORIES)).required() }),
  })
  .when(is(K.COMORBIDITY), {
    then: Joi.object({
      category: Joi.string().valid(...keys(COMORBIDITY_CATEGORIES)).required(),
      title: SAFE(255).required().messages({ "any.required": "Enter the condition" }),
    }),
  })
  .when(is(K.EXAMINATION), {
    then: Joi.object({
      category: Joi.string().valid(...keys(EXAMINATION_FORMS)).required(),
      details: details.required(),
    }),
  })
  .when(is(K.DIAGNOSIS), {
    then: Joi.object({
      title: SAFE(255).required().messages({ "any.required": "Enter the diagnosis" }),
      category: Joi.string().valid(...DIAGNOSIS_TYPES).required(),
      details: Joi.object({ stage: SAFE(60).allow("", null) }).allow(null),
    }),
  })
  .when(is(K.INVESTIGATION), {
    then: Joi.object({
      title: SAFE(255).required().messages({ "any.required": "Choose or enter the investigation" }),
      category: Joi.string().valid(...INVESTIGATION_TYPES).required(),
      details: Joi.object({
        priority: Joi.string().valid(...ORDER_PRIORITIES).required(),
        quantity: Joi.number().integer().min(1).max(99).default(1),
        diagnosticTestId: ID.allow(null),
      }).required(),
    }),
  })
  .when(is(K.DOCTOR_NOTE), {
    then: Joi.object({
      category: Joi.string().valid(...DOCTOR_NOTE_TYPES).required(),
      remarks: SAFE(10000).required().messages({ "any.required": "Write the note" }),
    }),
  })
  .custom((value, helpers) => {
    if (value.icdCodeId != null && value.kind !== K.DIAGNOSIS) return helpers.message("Only a diagnosis carries an ICD code");
    // History / examination entries with nothing written are not a record.
    if ([K.HISTORY, K.EXAMINATION].includes(value.kind)) {
      const written = Object.values(value.details || {}).some((v) => v != null && String(v).trim() !== "");
      if (!written && !(value.remarks || "").trim()) return helpers.message("Write at least one finding");
    }
    return value;
  }, "has content");

/** Correct an entry in place (author only, inside the edit window — enforced in the service). */
const updateEntry = Joi.object({
  title: SAFE(255).allow("", null),
  code: ICD.allow("", null),
  details: details.allow(null),
  remarks: SAFE(10000).allow("", null),
  recordedOn: DAY.allow(null),
  patientVisible: Joi.boolean(),
}).min(1);

const retireEntry = Joi.object({ reason: SAFE(255).min(3).required() });

module.exports = {
  workbenchQuery,
  workspaceQuery,
  timelineQuery,
  auditQuery,
  vitalsQuery,
  entriesQuery,
  searchQuery,
  patientParams,
  bookingParams,
  visitParams,
  idParams,
  addVitals,
  createEntry,
  updateEntry,
  retireEntry,
};
