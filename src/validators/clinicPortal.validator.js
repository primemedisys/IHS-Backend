/**
 * Joi schemas for the clinic portal.
 *
 * Most WRITE schemas here are deliberately re-exported from the patient/booking
 * validators rather than re-declared — a clinic recording a vitals reading must
 * accept exactly the same body a patient does, or the two entry points would
 * validate the same medical field differently.
 *
 * The genuinely new ones are the clinic's own profile, the ADD-only allergy /
 * condition writes (no `noKnown`, no replace semantics), and the narrow patch a
 * clinic may apply to a patient's booking-required fields.
 */
const Joi = require("joi");
const { CLINIC_DOC_TYPES } = require("../config/constants");
const patientSchema = require("./patient.validator");
const bookingSchema = require("./booking.validator");
const clinicalNoteSchema = require("./clinicalNote.validator");

const SEVERITIES = ["mild", "moderate", "severe"];

const phone = Joi.string()
  .trim()
  .pattern(/^[0-9+\-\s()]{7,20}$/)
  .messages({ "string.pattern.base": "Phone number is not valid" });

// ── The clinic's own profile ─────────────────────────────────────────────────

/**
 * `lat`/`lng` are bounded to India's envelope so a mis-dragged map pin fails
 * here rather than placing a clinic in the ocean. Both are nullable so a clinic
 * can clear the pin and re-place it.
 */
const updateClinicProfile = Joi.object({
  clinicName: Joi.string().trim().min(2).max(150),
  registrationNumber: Joi.string().trim().max(100).allow("", null),
  phone: phone.allow("", null),
  addressLine: Joi.string().trim().max(255).allow("", null),
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
  pincode: Joi.string().trim().max(10).allow("", null),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
  logoUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(512).allow("", null),
  about: Joi.string().trim().max(1000).allow("", null),
}).min(1);

/** Multipart: the file itself is validated by the upload middleware. */
const uploadClinicDocument = Joi.object({
  docType: Joi.string()
    .valid(...Object.values(CLINIC_DOC_TYPES))
    .required(),
});

// ── The patient directory ────────────────────────────────────────────────────

/**
 * `validateQuery`, not `validate` — Express 5's `req.query` has no setter, so
 * the reassigning middleware would throw.
 */
const listPatients = Joi.object({
  q: Joi.string().trim().max(100).allow("").default(""),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(50).default(20),
});

// ── Writes onto a patient's record ───────────────────────────────────────────

/**
 * ADD allergies. Note what is NOT here: `noKnown`. That flag is the patient's
 * own assertion about themselves, and this endpoint only ever appends — so a
 * clinic can never clear a patient's allergy list, only lengthen it.
 */
const addAllergies = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required(),
        severity: Joi.string()
          .valid(...SEVERITIES)
          .allow(null),
      })
    )
    .min(1)
    .max(50)
    .required(),
});

/** ADD conditions — same add-only rule as allergies. */
const addConditions = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required(),
        diagnosedYear: Joi.number()
          .integer()
          .min(1900)
          .max(new Date().getFullYear())
          .allow(null),
      })
    )
    .min(1)
    .max(50)
    .required(),
});

/**
 * The ONLY patient fields a clinic may write: the four that gate booking
 * (`PATIENT_REQUIRED_FIELDS`) plus blood group, which a clinic legitimately
 * measures. Everything else about the patient — their address, emergency
 * contact, name and account — is theirs alone.
 */
const updatePatientProfile = Joi.object({
  phone: phone.allow("", null),
  dateOfBirth: Joi.date().iso(),
  gender: Joi.string().valid("male", "female", "other"),
  city: Joi.string().trim().max(100).allow("", null),
  bloodGroup: Joi.string().valid("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"),
}).min(1);

module.exports = {
  updateClinicProfile,
  uploadClinicDocument,
  listPatients,
  addAllergies,
  addConditions,
  updatePatientProfile,
  // Re-exported verbatim so a clinic and a patient are validated identically.
  addVitalsEntry: patientSchema.addVitalsEntry,
  addRecord: patientSchema.addRecord,
  uploadRecord: patientSchema.uploadRecord,
  createNote: clinicalNoteSchema.createNote,
  createBooking: bookingSchema.createBooking,
};
