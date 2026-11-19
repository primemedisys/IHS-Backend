/**
 * Joi schemas for the /patient/profile + health-record endpoints. This is the
 * ONLY place request SHAPE is validated; field PRESENCE for the booking gate is
 * a separate concern (patient.service.computeProfileStatus) — a partial update
 * is always allowed (the patient fills their profile incrementally).
 */
const Joi = require("joi");
const { GENDERS, RECORD_FILE_TYPES, DOCUMENT_KINDS } = require("../config/constants");

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"];
const SEVERITIES = ["mild", "moderate", "severe"];

const phone = Joi.string()
  .trim()
  .pattern(/^[+]?[\d\s-]{7,20}$/)
  .messages({ "string.pattern.base": "Phone number is not valid" });

/**
 * Partial profile update. Every field is optional (incremental fill), but at
 * least one must be present. Presence of the *required-to-book* fields is not
 * enforced here — the completeness engine owns that.
 */
const updateProfile = Joi.object({
  name: Joi.string().trim().min(2).max(150),
  phone: phone.allow("", null),
  dateOfBirth: Joi.date().iso().max("now").messages({ "date.max": "Date of birth must be in the past" }),
  gender: Joi.string().valid(...GENDERS),
  bloodGroup: Joi.string().valid(...BLOOD_GROUPS),
  emergencyContactName: Joi.string().trim().max(150).allow("", null),
  emergencyContactPhone: phone.allow("", null),
  addressLine: Joi.string().trim().max(255).allow("", null),
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
  pincode: Joi.string().trim().max(20).allow("", null),
  noKnownAllergies: Joi.boolean(),
  noKnownConditions: Joi.boolean(),
}).min(1);

/** Replace-the-set of allergies (+ the "no known" acknowledgement). */
const setAllergies = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required(),
        severity: Joi.string().valid(...SEVERITIES).allow(null),
      })
    )
    .max(50)
    .default([]),
  noKnown: Joi.boolean(),
});

/** Replace-the-set of chronic conditions (+ the "no known" acknowledgement). */
const setConditions = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required(),
        diagnosedYear: Joi.number().integer().min(1900).max(new Date().getFullYear()).allow(null),
      })
    )
    .max(50)
    .default([]),
  noKnown: Joi.boolean(),
});

/** Create a current-medication row. */
const createMedication = Joi.object({
  medicineName: Joi.string().trim().min(1).max(200).required(),
  dosage: Joi.string().trim().max(100).allow("", null),
  frequency: Joi.string().trim().max(100).allow("", null),
  startedOn: Joi.date().iso().max("now").allow(null),
  notes: Joi.string().trim().max(255).allow("", null),
});

/** Patch a current-medication row (at least one field). */
const updateMedication = Joi.object({
  medicineName: Joi.string().trim().min(1).max(200),
  dosage: Joi.string().trim().max(100).allow("", null),
  frequency: Joi.string().trim().max(100).allow("", null),
  startedOn: Joi.date().iso().max("now").allow(null),
  notes: Joi.string().trim().max(255).allow("", null),
}).min(1);

/**
 * The "I take nothing" answer on the medications list — the counterpart of the
 * `noKnown` flag that setAllergies/setConditions already carry.
 */
const setNoCurrentMedications = Joi.object({
  noCurrentMedications: Joi.boolean().required(),
});

/**
 * Document-library fields shared by add / upload / edit (migration 058).
 * `documentKind` decides the stored file_type server-side; `idLast4` takes
 * exactly four digits and nothing more — a full Aadhaar number is never stored.
 */
const RECORD_FILE_TYPE = Joi.string().valid(...RECORD_FILE_TYPES);
const documentFields = {
  documentKind: Joi.string().valid(...DOCUMENT_KINDS).allow("", null),
  doctorName: Joi.string().trim().max(120).allow("", null),
  description: Joi.string().trim().max(1000).allow("", null),
  idLast4: Joi.string()
    .trim()
    .pattern(/^[0-9]{4}$/)
    .allow("", null)
    .messages({ "string.pattern.base": "Enter only the last 4 digits" }),
};

/** Add an uploaded record by URL (paste-a-link). */
const addRecord = Joi.object({
  fileUrl: Joi.string().trim().uri({ scheme: ["http", "https"] }).max(500).required(),
  fileType: RECORD_FILE_TYPE.default("prescription"),
  recordDate: Joi.date().iso().max("now").allow(null),
  tag: Joi.string().trim().max(100).allow("", null),
  location: Joi.string().trim().max(150).allow("", null),
  ...documentFields,
});

/** Add an uploaded record as a real file (multipart; the file itself is
 * validated in middleware — mimetype/size/content signature — not Joi). */
const uploadRecord = Joi.object({
  fileType: RECORD_FILE_TYPE.default("prescription"),
  recordDate: Joi.date().iso().max("now").allow("", null),
  tag: Joi.string().trim().max(100).allow("", null),
  location: Joi.string().trim().max(150).allow("", null),
  ...documentFields,
});

/**
 * Edit an existing record's descriptive fields. The file itself is swapped
 * only through PUT /records/:id/file.
 * `.min(1)` mirrors updateMedication: an empty PATCH is a client bug, not a no-op.
 */
const updateRecord = Joi.object({
  fileType: RECORD_FILE_TYPE,
  recordDate: Joi.date().iso().max("now").allow(null),
  tag: Joi.string().trim().max(100).allow("", null),
  location: Joi.string().trim().max(150).allow("", null),
  ...documentFields,
}).min(1);

/**
 * A doctor correcting the DATE a document speaks for (a prescription uploaded
 * today may be dated weeks back). Date only — the file, its type and its label
 * stay whatever the uploader chose.
 */
const updateRecordDate = Joi.object({
  recordDate: Joi.date().iso().max("now").required(),
});

const VITAL_FIELDS = ["bloodPressure", "pulseRateBpm", "weightKg", "heightCm", "temperatureF", "spo2Percent"];

/**
 * Add a dated vitals reading (a record-table column). Same ranges as the
 * clinical-note vitals; at least one vital is required (an empty column is
 * meaningless — mirrors the note's "≥1 detail" rule).
 */
const addVitalsEntry = Joi.object({
  recordedOn: Joi.date().iso().max("now").default(() => new Date()),
  bloodPressure: Joi.string().trim().max(20).allow("", null),
  pulseRateBpm: Joi.number().integer().min(0).max(400).allow(null),
  weightKg: Joi.number().min(0).max(1000).allow(null),
  heightCm: Joi.number().min(0).max(300).allow(null),
  temperatureF: Joi.number().min(0).max(120).allow(null),
  spo2Percent: Joi.number().integer().min(0).max(100).allow(null),
  note: Joi.string().trim().max(255).allow("", null),
  // Required: where the reading was taken (picked from Google Maps on the client).
  location: Joi.string().trim().min(1).max(150).required().messages({
    "any.required": "Location is required",
    "string.empty": "Location is required",
  }),
}).custom((value, helpers) => {
  const hasVital = VITAL_FIELDS.some((k) => {
    const x = value[k];
    return typeof x === "number" || (typeof x === "string" && x.trim() !== "");
  });
  if (!hasVital) return helpers.message("Add at least one vital before saving the reading.");
  return value;
}, "at least one vital");

module.exports = {
  updateProfile,
  setAllergies,
  setConditions,
  createMedication,
  updateMedication,
  setNoCurrentMedications,
  addRecord,
  uploadRecord,
  updateRecord,
  updateRecordDate,
  addVitalsEntry,
};
