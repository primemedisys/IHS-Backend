/**
 * Joi schemas for every writable doctor / admin-verification endpoint. This is
 * the ONLY place these request shapes are validated — controllers trust
 * `req.body` completely. Enums come from config/constants so the model, the DB,
 * and these schemas never drift on a string literal.
 */
const Joi = require("joi");
const {
  DOC_TYPES,
  GENDERS,
  LINK_TYPES,
  EXPERTISE_CATEGORIES,
  GALLERY_CATEGORIES,
} = require("../config/constants");

/** A year within a sane range (shared by education/experience/etc.). */
const year = () => Joi.number().integer().min(1950).max(2100);

/** ASCII control characters (keeps tab / newline / CR) — never meaningful in profile text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Trimmed free text with control characters stripped. Optional fields add `.allow("", null)`. */
const text = (max) => Joi.string().replace(CONTROL_CHARS, "").trim().max(max);

/** A short label (chip / name): whitespace runs collapsed, so "Heart  failure" equals "Heart failure". */
const label = (max) => text(max).replace(/\s+/g, " ");

/** Optional http(s) link. */
const optionalUrl = () => Joi.string().trim().uri({ scheme: ["http", "https"] }).max(300).allow("", null);

/**
 * Object-level check shared by every start/end-year pair: the end can't come
 * before the start. Only runs when BOTH are in the same body (a PATCH that
 * sends one year alone is not cross-checked against the stored row).
 */
const yearOrder = (startKey, endKey, endLabel) => (value, helpers) => {
  const start = value[startKey];
  const end = value[endKey];
  if (Number.isInteger(start) && Number.isInteger(end) && end < start) {
    return helpers.message(`${endLabel} can't be before the start year`);
  }
  return value;
};

/**
 * Turn a `create*` schema into its PATCH counterpart: every key optional, but at
 * least one supplied. Keeps create/update in ONE definition (no drift).
 */
const partialOf = (schema) =>
  // Clearing the create-time default means a PATCH that leaves a key out never
  // resets it (e.g. experience.isCurrent back to false).
  schema.fork(Object.keys(schema.describe().keys), (s) => s.optional().$_setFlag("default", undefined)).min(1);

// ── Doctor-owned ────────────────────────────────────────────────────────────
const updateProfile = Joi.object({
  qualification: Joi.string().trim().max(255),
  registrationNumber: Joi.string().trim().max(100), // real value; uniqueness checked in service
  experienceYears: Joi.number().integer().min(0).max(80),
  bio: Joi.string().trim().max(5000).allow("", null),
  onlineFee: Joi.number().min(0).allow(null),
  // ── Portfolio v2 hero / about / contact ──
  headline: Joi.string().trim().max(160).allow("", null),
  gender: Joi.string().valid(...GENDERS),
  practicePhilosophy: Joi.string().trim().max(1000).allow("", null),
  publicPhone: Joi.string().trim().max(20).allow("", null),
  publicEmail: Joi.string().trim().email().max(190).allow("", null),
  // ── About section extras (migration 049) ──
  shortIntro: text(500).allow("", null),
  careerSummary: text(2000).allow("", null),
}).min(1);

const setSpecializations = Joi.object({
  specializationIds: Joi.array()
    .items(Joi.number().integer().positive())
    .min(1)
    .max(5)
    .unique()
    .required(),
});

// Empty array allowed: a doctor can clear their sub-specialties.
const setSubSpecializations = Joi.object({
  subSpecializationIds: Joi.array()
    .items(Joi.number().integer().positive())
    .max(10)
    .unique()
    .required(),
});

// Doctor "+ Add new sub-specialty". Latin letters/digits and light punctuation
// only (the row's slug is built from it); must contain at least one letter.
const createSubSpecialization = Joi.object({
  specializationId: Joi.number().integer().positive().required(),
  name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .pattern(/^[A-Za-z0-9 &()/,.'+-]+$/)
    .pattern(/[A-Za-z]/)
    .required()
    .messages({
      "string.pattern.base": "Use letters, numbers, spaces and & ( ) / , . ' + - only",
      "string.min": "Enter at least 2 characters",
      "string.empty": "Enter a sub-specialty name",
    }),
});

const setLanguages = Joi.object({
  languageIds: Joi.array()
    .items(Joi.number().integer().positive())
    .min(1)
    .max(10)
    .unique()
    .required(),
});

const createAward = Joi.object({
  title: Joi.string().trim().max(255).required(),
  // Issuing organisation (migration 048) — optional.
  issuer: Joi.string().trim().max(255).allow("", null),
  description: Joi.string().trim().max(500).allow("", null),
  awardYear: Joi.number().integer().min(1950).max(2100).allow(null),
  // the optional picture is uploaded separately: POST /doctor/awards/:id/image
});

const createLink = Joi.object({
  linkType: Joi.string()
    .valid(...Object.values(LINK_TYPES))
    .required(),
  url: Joi.string().uri({ scheme: ["http", "https"] }).max(300).required(),
});

const createKeyword = Joi.object({
  keyword: Joi.string().trim().max(150).required(),
  weight: Joi.number().integer().min(1).max(5).default(1),
});

const uploadDocument = Joi.object({
  docType: Joi.string()
    .valid(...Object.values(DOC_TYPES))
    .required(),
  // the file itself is validated in middleware (mimetype/size), not Joi
});

// ── Portfolio v2 section schemas (create; PATCH = partialOf(...) in the route) ─
// Every optional field also accepts null, so an edit can CLEAR a value (a blank
// field is sent as null rather than silently dropped).
const createEducation = Joi.object({
  degree: Joi.string().trim().max(150).required(),
  institution: Joi.string().trim().max(200).required(),
  fieldOfStudy: Joi.string().trim().max(150).allow("", null),
  location: text(150).allow("", null), // migration 049
  yearFrom: year().allow(null),
  yearTo: year().allow(null),
}).custom(yearOrder("yearFrom", "yearTo", "The completion year"));

const createExperience = Joi.object({
  organization: Joi.string().trim().max(200).required(),
  roleTitle: Joi.string().trim().max(150).required(),
  location: text(150).allow("", null), // migration 049
  startYear: year().required(),
  endYear: year().allow(null),
  isCurrent: Joi.boolean().default(false),
  description: Joi.string().trim().max(500).allow("", null),
}).custom(yearOrder("startYear", "endYear", "The end year"));

const createService = Joi.object({
  name: Joi.string().trim().max(150).required(),
  description: Joi.string().trim().max(500).allow("", null),
});

const createPublication = Joi.object({
  title: Joi.string().trim().max(300).required(),
  publisher: Joi.string().trim().max(200).allow("", null),
  year: year().allow(null),
  url: Joi.string().uri({ scheme: ["http", "https"] }).max(300).allow("", null),
  // ── Migration 049 (all optional) ──
  authors: text(500).allow("", null),
  // A bare DOI ("10.1000/xyz123"), not a URL — the portfolio links it to doi.org.
  doi: Joi.string()
    .trim()
    .max(150)
    .pattern(/^10\.\d{4,9}\/\S+$/)
    .allow("", null)
    .messages({ "string.pattern.base": "Enter a DOI like 10.1000/xyz123" }),
  abstract: text(2000).allow("", null),
  category: label(100).allow("", null),
});

const createMembership = Joi.object({
  organization: Joi.string().trim().max(200).required(),
  roleTitle: Joi.string().trim().max(150).allow("", null),
  sinceYear: year().allow(null),
  // ── Migration 049 (all optional) ──
  membershipNumber: text(100).allow("", null),
  // Private by default: the number is shown publicly only when this is true.
  showMembershipNumber: Joi.boolean(),
  validUntilYear: year().allow(null),
  description: text(500).allow("", null),
}).custom(yearOrder("sinceYear", "validUntilYear", "The expiry year"));

// ── Migration 049 sections ──
const createAffiliation = Joi.object({
  organization: text(200).required(),
  roleTitle: text(150).allow("", null),
  department: text(150).allow("", null),
  location: text(255).allow("", null),
  startYear: year().allow(null),
  endYear: year().allow(null),
  isCurrent: Joi.boolean(),
  website: optionalUrl(),
  phone: Joi.string()
    .trim()
    .max(20)
    .pattern(/^[0-9+()\-\s]{6,20}$/)
    .allow("", null)
    .messages({ "string.pattern.base": "Enter a valid phone number" }),
})
  .custom(yearOrder("startYear", "endYear", "The end year"))
  .custom((value, helpers) =>
    value.isCurrent === true && Number.isInteger(value.endYear)
      ? helpers.message("A current affiliation can't have an end year")
      : value
  );

const createFellowship = Joi.object({
  title: text(200).required(),
  institution: text(200).required(),
  specialtyArea: text(150).allow("", null),
  location: text(150).allow("", null),
  startYear: year().allow(null),
  // Completion year; null while the training is ongoing.
  endYear: year().allow(null),
  description: text(1000).allow("", null),
}).custom(yearOrder("startYear", "endYear", "The completion year"));

const createExpertise = Joi.object({
  category: Joi.string()
    .valid(...Object.values(EXPERTISE_CATEGORIES))
    .required(),
  name: label(150).min(2).required(),
  description: text(300).allow("", null),
});

const createFaq = Joi.object({
  question: Joi.string().trim().max(300).required(),
  answer: Joi.string().trim().max(1000).required(),
});

/** Clinical-gallery metadata (migration 049) — shared by upload and PATCH. */
const galleryFields = {
  title: text(150).allow("", null),
  caption: Joi.string().trim().max(255).allow("", null),
  category: Joi.string()
    .valid(...GALLERY_CATEGORIES)
    .allow("", null),
  altText: text(255).allow("", null),
  // Kept as a "YYYY-MM-DD" string (a DATE column) so no timezone can shift it.
  takenOn: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .custom((v, helpers) => {
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return helpers.message("Enter a valid date");
      if (d.getTime() > Date.now()) return helpers.message("The date can't be in the future");
      return v;
    })
    .allow("", null)
    .messages({ "string.pattern.base": "Enter a valid date" }),
};

const uploadGallery = Joi.object({
  ...galleryFields,
  // The web panel requires the doctor to confirm the photo shows no
  // identifiable patient (or that consent was obtained). Optional here so
  // older clients (the mobile app) keep uploading.
  consent: Joi.boolean(),
  // the image file is validated in middleware (mimetype/size), not Joi
});

/** PATCH /doctor/gallery/:id — metadata only; the picture itself is immutable. */
const updateGallery = Joi.object(galleryFields).min(1);

/** PUT /doctor/gallery/order and /doctor/testimonials/order — every id, in the new order. */
const reorderIds = Joi.object({
  ids: Joi.array()
    .items(Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/)))
    .max(200)
    .required(),
});

/** POST /doctor/hero-images — optional `slot` replaces that image (0-based). */
const uploadHeroImage = Joi.object({
  slot: Joi.number().integer().min(0).max(2),
  // the image file is validated in middleware (mimetype/size) + the service
});

/**
 * Doctor-managed patient testimonial (migration 048). The doctor enters these;
 * the photo is uploaded separately and only with the patient's consent.
 */
const createTestimonial = Joi.object({
  patientName: Joi.string().trim().min(2).max(120).required(),
  reviewText: Joi.string().trim().min(10).max(1500).required(),
  rating: Joi.number().integer().min(1).max(5).required(),
  reviewDate: Joi.date().iso().max("now").allow(null),
  isVisible: Joi.boolean(),
});

/** PUT /doctor/testimonials/order — every testimonial id, in the new order. */
const reorderTestimonials = reorderIds;

/**
 * POST /doctor/testimonials/:id/photo — the doctor must confirm the patient
 * agreed to their photo being shown publicly.
 */
const testimonialPhoto = Joi.object({
  consent: Joi.boolean().valid(true).required().messages({
    "any.only": "Confirm the patient agreed to their photo being shown on your public profile",
    "any.required": "Confirm the patient agreed to their photo being shown on your public profile",
  }),
});

/** DELETE /doctor/hero-images/:index */
const heroImageIndex = Joi.object({
  index: Joi.number().integer().min(0).max(2).required(),
});

const setInsurances = Joi.object({
  insuranceIds: Joi.array().items(Joi.number().integer().positive()).max(20).unique().required(),
});

// ── Admin verification ──────────────────────────────────────────────────────
// Note: the review-queue `?status=` filter is normalized in verification.service
// (Express 5 makes req.query read-only), so it has no Joi schema here.
const verifyDoctor = Joi.object({
  decision: Joi.string().valid("approved", "rejected").required(),
  notes: Joi.string().trim().max(500).allow("", null),
});

/** The admin's public-visibility toggle (migration 014). */
const setListing = Joi.object({
  isListed: Joi.boolean().required(),
});

module.exports = {
  updateProfile,
  setSpecializations,
  setSubSpecializations,
  createSubSpecialization,
  setLanguages,
  createAward,
  createLink,
  createKeyword,
  uploadDocument,
  verifyDoctor,
  setListing,
  // Portfolio v2
  partialOf,
  createEducation,
  createExperience,
  createService,
  createPublication,
  createMembership,
  createFaq,
  uploadGallery,
  updateGallery,
  reorderGallery: reorderIds,
  createAffiliation,
  createFellowship,
  createExpertise,
  uploadHeroImage,
  heroImageIndex,
  createTestimonial,
  reorderTestimonials,
  testimonialPhoto,
  setInsurances,
};
