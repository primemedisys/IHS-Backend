/**
 * Joi validators for the Diagnostic Lab flow (migration 038). Validation lives
 * ONLY here — controllers trust `req.body` / `req.validatedQuery` after
 * `validate()` / `validateQuery()`, and the service never re-validates shape.
 */
const Joi = require("joi");
const {
  DIAGNOSTIC_REQUEST_STATUS,
  DIAGNOSTIC_TEST_STATUS,
  DIAGNOSTIC_REPORT_FILE_TYPES,
} = require("../config/constants");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);
const PRICE = Joi.number().precision(2).min(0).max(10000000);
const SAFE = (max) => Joi.string().trim().max(max);

// ── Patient ──────────────────────────────────────────────────────────────

/** Nearby labs: the SAME Google city/state selection the pharmacy share uses. */
const listLabs = Joi.object({
  city: SAFE(100).allow("", null),
  state: SAFE(100).allow("", null),
  search: SAFE(100).allow("", null),
  page: PAGE,
  limit: LIMIT,
});

/** Multipart share (file comes through upload.single("prescription")). */
const shareRequest = Joi.object({
  // multipart sends one `labIds` field per lab, so one pick arrives as a plain
  // string; `.single()` maps that to [id] (same as the pharmacy providerIds).
  labIds: Joi.array().items(ID).min(1).max(20).single().required(),
  notes: SAFE(1000).allow("", null),
  city: SAFE(100).allow("", null),
  state: SAFE(100).allow("", null),
});

const listRequests = Joi.object({
  status: Joi.string().valid(...Object.values(DIAGNOSTIC_REQUEST_STATUS)),
  from: Joi.date().iso(),
  to: Joi.date().iso().when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")) }),
  page: PAGE,
  limit: LIMIT,
});

/** The patient books some of the lab's AVAILABLE tests for a date. */
const book = Joi.object({
  testIds: Joi.array().items(ID).min(1).max(50).required().messages({
    "array.min": "Select at least one test",
  }),
  preferredDate: Joi.date().iso().required(),
  notes: SAFE(500).allow("", null),
});

// ── Lab ──────────────────────────────────────────────────────────────────

const updateStatus = Joi.object({
  status: Joi.string()
    .valid(
      DIAGNOSTIC_REQUEST_STATUS.VIEWED,
      DIAGNOSTIC_REQUEST_STATUS.CONFIRMED,
      DIAGNOSTIC_REQUEST_STATUS.TEST_COMPLETED,
      DIAGNOSTIC_REQUEST_STATUS.REJECTED
    )
    .required(),
  note: SAFE(500).allow("", null),
});

/**
 * The lab's answer for one test. Available: either one of its own catalogue
 * tests (`diagnosticTestId`, price defaults to the catalogue price) or a test
 * typed in (`testName` + `price`). Unavailable: a name + optional reason.
 */
const testAnswer = Joi.alternatives().try(
  Joi.object({
    status: Joi.string().valid(DIAGNOSTIC_TEST_STATUS.AVAILABLE).required(),
    diagnosticTestId: ID,
    testName: SAFE(150).allow("", null),
    price: PRICE,
  })
    .or("diagnosticTestId", "testName")
    // A typed-in test has no catalogue price to fall back on.
    .when(Joi.object({ diagnosticTestId: Joi.exist() }).unknown(), {
      otherwise: Joi.object({ testName: SAFE(150).min(1).required(), price: PRICE.required() }),
    }),
  Joi.object({
    status: Joi.string().valid(DIAGNOSTIC_TEST_STATUS.UNAVAILABLE).required(),
    testName: SAFE(150).min(1).required(),
    reason: SAFE(255).allow("", null),
  })
);

const respond = Joi.object({
  tests: Joi.array().items(testAnswer).min(1).max(50).required(),
  note: SAFE(500).allow("", null),
});

/** Multipart report upload (file comes through upload.single("report")). */
const uploadReport = Joi.object({
  // One file may cover several tests (a combined report).
  testIds: Joi.array().items(ID).min(1).max(50).single().required(),
  fileType: Joi.string()
    .valid(...DIAGNOSTIC_REPORT_FILE_TYPES)
    .default("lab_report"),
});

// ── Lab catalogue ────────────────────────────────────────────────────────

const createTest = Joi.object({
  name: SAFE(150).min(1).required(),
  description: SAFE(500).allow("", null),
  price: PRICE.required(),
  isAvailable: Joi.boolean().default(true),
});

const updateTest = Joi.object({
  name: SAFE(150).min(1),
  description: SAFE(500).allow("", null),
  price: PRICE,
  isAvailable: Joi.boolean(),
}).min(1);

const listTests = Joi.object({
  search: SAFE(100).allow("", null),
});

// ── Admin ────────────────────────────────────────────────────────────────

const adminListRequests = Joi.object({
  status: Joi.string().valid(...Object.values(DIAGNOSTIC_REQUEST_STATUS)),
  labId: ID,
  from: Joi.date().iso(),
  to: Joi.date().iso().when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")) }),
  page: PAGE,
  limit: LIMIT,
});

module.exports = {
  listLabs,
  shareRequest,
  listRequests,
  book,
  updateStatus,
  respond,
  uploadReport,
  createTest,
  updateTest,
  listTests,
  adminListRequests,
};
