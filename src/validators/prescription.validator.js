/**
 * Joi schemas for the letterhead templates and the prescriptions written on
 * them (docs/prescriptions/backend-plan.md §5).
 *
 * The JSON columns get REAL schemas. `headerJson.credentialLines`,
 * `sidebarJson.groups[].items` and `footerJson.columns[].lines` are
 * doctor-supplied strings that end up inside a Chromium page and inside a PDF
 * the PATIENT opens. Bounding their length here and escaping them in the
 * renderer are both required: a length cap doesn't stop `<script>`, and
 * escaping without a cap doesn't stop a 4 MB credential line OOM-ing the render.
 */
const Joi = require("joi");
const {
  MEDICINE_ROUTES,
  MEDICINE_TIMINGS,
  MEDICINE_DURATION_UNITS,
  MEDICINE_COLUMNS,
  TEMPLATE_ASSET_KINDS,
  PRESCRIPTION_PATIENT_FIELDS,
  PRESCRIPTION_FONTS,
  PRESCRIPTION_STATUS,
  ORDER_PRIORITIES,
  MEDICINE_NAME_TYPES,
  MEDICINE_TYPES,
} = require("../config/constants");

const HEX = Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).message("must be a hex colour like #2E4A2E");
const SAFE = (max) => Joi.string().trim().max(max);
const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));

// ── The five JSON blobs ──────────────────────────────────────────────────────
const headerJson = Joi.object({
  doctorNameLine: SAFE(120).required(),
  credentialLines: Joi.array().items(SAFE(160)).max(10).default([]),
  clinicName: SAFE(120).allow("").default(""),
  clinicTagline: SAFE(160).allow("").default(""),
  regNoLabel: SAFE(40).allow("").default("Regd. No."),
  regNoValue: SAFE(60).allow("").default(""),
  logoPosition: Joi.string().valid("left", "right").default("right"),
});

const patientFieldsJson = Joi.array()
  .max(PRESCRIPTION_PATIENT_FIELDS.length)
  .items(
    Joi.object({
      key: Joi.string().valid(...PRESCRIPTION_PATIENT_FIELDS).required(),
      label: SAFE(40).required(),
      enabled: Joi.boolean().default(true),
      row: Joi.number().integer().min(1).max(3).default(1),
    })
  )
  .unique("key");

const sidebarJson = Joi.object({
  title: SAFE(60).allow("").default("Advice"),
  groups: Joi.array()
    .max(6)
    .items(
      Joi.object({
        title: SAFE(60).allow("").default(""),
        items: Joi.array().items(SAFE(80)).max(60).required(),
      })
    )
    .required(),
});

const bodyJson = Joi.object({
  rxSymbol: Joi.boolean().default(true),
  showDiagnosis: Joi.boolean().default(true),
  showVitals: Joi.boolean().default(true),
  medicineColumns: Joi.array()
    .items(Joi.string().valid(...MEDICINE_COLUMNS))
    .min(1)
    .unique()
    .default(["medicineName", "dosage", "frequency", "timing", "durationDays"]),
  showAdviceText: Joi.boolean().default(true),
  showFollowUp: Joi.boolean().default(true),
  disclaimer: SAFE(300).allow("").default(""),
});

const footerJson = Joi.object({
  columns: Joi.array()
    .min(1)
    .max(4)
    .items(
      Joi.object({
        title: SAFE(40).allow("").default(""),
        lines: Joi.array().items(SAFE(120)).max(6).required(),
      })
    )
    .required(),
});

// ── Templates ────────────────────────────────────────────────────────────────
/** Every themeable/scalar field. Reused by create (with defaults) and update (all optional). */
const templateFields = {
  name: SAFE(120),
  clinicId: ID.allow(null),
  isActive: Joi.boolean(),

  watermarkOpacity: Joi.number().min(0).max(0.5),

  headerBgColor: HEX,
  headerTextColor: HEX,
  footerBgColor: HEX,
  footerTextColor: HEX,
  accentColor: HEX,
  fontFamily: Joi.string().valid(...PRESCRIPTION_FONTS),
  baseFontSizePt: Joi.number().min(7).max(16),

  pageSize: Joi.string().valid("A4", "Letter"),
  marginMmTop: Joi.number().integer().min(0).max(40),
  marginMmRight: Joi.number().integer().min(0).max(40),
  marginMmBottom: Joi.number().integer().min(0).max(40),
  marginMmLeft: Joi.number().integer().min(0).max(40),

  showHeader: Joi.boolean(),
  showFooter: Joi.boolean(),
  showSidebar: Joi.boolean(),
  showWatermark: Joi.boolean(),
  sidebarWidthPct: Joi.number().integer().min(10).max(35),

  rxNumberPrefix: SAFE(10).allow("", null),

  headerJson,
  patientFieldsJson,
  sidebarJson,
  bodyJson,
  footerJson,
};

const createTemplate = Joi.object({
  ...templateFields,
  name: SAFE(120).required(),
});

// PATCH: any subset, but not an empty body (which would be a silent no-op).
const updateTemplate = Joi.object(templateFields).min(1);

const duplicateTemplate = Joi.object({
  name: SAFE(120).required(),
  clinicId: ID.allow(null).default(null),
});

const uploadAsset = Joi.object({
  kind: Joi.string().valid(...TEMPLATE_ASSET_KINDS).required(),
});

// ── Prescriptions ────────────────────────────────────────────────────────────
const item = Joi.object({
  medicineId: ID.allow(null).default(null),
  medicineMasterId: ID.allow(null).default(null),
  medicineName: SAFE(200).required(),
  // Migration 053 — the medicine's strength and dosage form (not the dose).
  strength: SAFE(100).allow("", null).default(null),
  dosageForm: Joi.string().valid(...MEDICINE_TYPES).allow(null).default(null),
  dosage: SAFE(100).allow("", null).default(null),
  route: Joi.string().valid(...MEDICINE_ROUTES).default("oral"),
  frequency: SAFE(100).allow("", null).default(null),
  timing: Joi.string().valid(...MEDICINE_TIMINGS).allow(null).default("after_food"),
  durationDays: Joi.number().integer().min(1).max(365).allow(null).default(null),
  durationUnit: Joi.string().valid(...MEDICINE_DURATION_UNITS).default("day"),
  notes: SAFE(255).allow("", null).default(null),
  // Migration 051 (EMR medication order). Optional and never inferred: an
  // empty quantity stays empty rather than being computed from the duration.
  quantity: Joi.number().integer().min(1).max(9999).allow(null).default(null),
  priority: Joi.string().valid(...ORDER_PRIORITIES).allow(null).default(null),
  nameType: Joi.string().valid(...MEDICINE_NAME_TYPES).allow(null).default(null),
});

const createPrescription = Joi.object({
  bookingId: ID.required(),
  templateId: ID.optional(),
});

// Vitals carry real clinical bounds — a typo'd pulse of 780 should not reach a PDF.
const updatePrescription = Joi.object({
  chiefComplaint: SAFE(500).allow("", null),
  diagnosis: SAFE(500).allow("", null),
  notes: SAFE(5000).allow("", null),
  advice: SAFE(5000).allow("", null),
  adviceSelected: Joi.array().items(SAFE(80)).max(60),
  followUpDate: Joi.date().iso().allow(null),
  templateId: ID.allow(null),
  // The doctor's explicit "medication not needed" (migration 051).
  noMedication: Joi.boolean(),

  vitals: Joi.object({
    heightCm: Joi.number().min(20).max(280).allow(null),
    weightKg: Joi.number().min(1).max(500).allow(null),
    bloodPressure: SAFE(20).allow("", null),
    pulseRateBpm: Joi.number().integer().min(20).max(300).allow(null),
    temperatureF: Joi.number().min(90).max(110).allow(null),
    spo2Percent: Joi.number().integer().min(50).max(100).allow(null),
  }),

  // Replace-the-set. An unbounded medicine array is an unbounded PDF.
  items: Joi.array().items(item).max(30),
}).min(1);

const finalizePrescription = Joi.object({
  emailPatient: Joi.boolean().default(false),
});

const amendPrescription = Joi.object({
  reason: SAFE(255).required(),
});

const listPrescriptions = Joi.object({
  status: Joi.string().valid(...Object.values(PRESCRIPTION_STATUS)),
  patientId: ID,
  bookingId: ID,
});

module.exports = {
  createTemplate,
  updateTemplate,
  duplicateTemplate,
  uploadAsset,
  createPrescription,
  updatePrescription,
  finalizePrescription,
  amendPrescription,
  listPrescriptions,
};
