/**
 * Joi schemas for the admin ICD code master (migration 059) and the doctor's
 * ICD search. Query schemas run through `validateQuery` (result on
 * req.validatedQuery); body schemas through `validate`.
 */
const Joi = require("joi");
const { ICD_CODING_SYSTEMS, ICD_IMPORT_MAX_ROWS, ICD_EXCEL } = require("../config/constants");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const SAFE = (max) => Joi.string().trim().max(max);
const SYSTEM = Joi.string().valid(...ICD_CODING_SYSTEMS.map((s) => s.key));
/** "2019", "FY2025", "2024-01" — the release of the classification. */
const VERSION = SAFE(30).pattern(/^[A-Za-z0-9][A-Za-z0-9 ._\-/]*$/).message("Version may use letters, digits, space, '.', '-', '_' and '/'");
/** The same character rule the diagnosis entry has always used for its code. */
const CODE = SAFE(20)
  .pattern(/^[A-Za-z0-9][A-Za-z0-9.\-]*$/)
  .message("ICD code may use letters, digits, '.' and '-'");

const listQuery = Joi.object({
  q: SAFE(100).allow(""),
  codingSystem: SYSTEM,
  systemVersion: VERSION,
  /** A category name, or "__none__" for rows without one. */
  category: SAFE(150).allow(""),
  status: Joi.string().valid("all", "active", "inactive").default("all"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const idParams = Joi.object({ id: ID.required() });

const create = Joi.object({
  codingSystem: SYSTEM.required(),
  systemVersion: VERSION.required(),
  code: CODE.required(),
  title: SAFE(255).min(2).required().messages({ "any.required": "Enter the diagnosis name" }),
  description: SAFE(1000).allow("", null),
  category: SAFE(150).allow("", null),
  isActive: Joi.boolean(),
});

const update = Joi.object({
  codingSystem: SYSTEM,
  systemVersion: VERSION,
  code: CODE,
  title: SAFE(255).min(2),
  description: SAFE(1000).allow("", null),
  category: SAFE(150).allow("", null),
  isActive: Joi.boolean(),
}).min(1);

const importRow = Joi.object({
  code: CODE.required(),
  title: SAFE(255).min(2).required(),
  description: SAFE(1000).allow("", null),
  category: SAFE(150).allow("", null),
});

const importBody = Joi.object({
  codingSystem: SYSTEM.required(),
  systemVersion: VERSION.required(),
  dryRun: Joi.boolean().default(false),
  rows: Joi.array().items(importRow).min(1).max(ICD_IMPORT_MAX_ROWS).required(),
});

// ── Excel import (multipart: the file + these text fields) ─────────────────
const excelPreview = Joi.object({ systemVersion: VERSION.required() });

const excelCommit = Joi.object({
  systemVersion: VERSION.required(),
  duplicatePolicy: Joi.string().valid(...ICD_EXCEL.DUPLICATE_POLICIES).default("skip"),
  /** The SHA-256 the preview returned — proves this is the reviewed file. */
  expectedSha256: Joi.string().trim().lowercase().pattern(/^[a-f0-9]{64}$/).required(),
});

const historyQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

const doctorEntriesQuery = Joi.object({
  q: SAFE(100).allow(""),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

/** Doctor search: a diagnosis name or a code ("low back pain", "M54.5", "m545"). */
const searchQuery = Joi.object({ q: SAFE(100).min(2).required() });

module.exports = {
  listQuery,
  idParams,
  create,
  update,
  importBody,
  excelPreview,
  excelCommit,
  historyQuery,
  doctorEntriesQuery,
  searchQuery,
};
