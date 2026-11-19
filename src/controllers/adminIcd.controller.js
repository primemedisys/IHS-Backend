/**
 * Admin ICD code master (migration 059). Thin wrappers: validated input → one
 * service call → serializer → envelope.
 */
const icd = require("../services/icdCode.service");
const icdImport = require("../services/icdImport.service");
const sendFile = require("../utils/sendFile");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { serializeIcdCode, serializeIcdPage } = require("../utils/serializers");

exports.meta = asyncHandler(async (_req, res) => ok(res, await icd.meta(), "ICD catalogue"));

exports.list = asyncHandler(async (req, res) =>
  ok(res, serializeIcdPage(await icd.list(req.validatedQuery)), "ICD codes")
);

exports.create = asyncHandler(async (req, res) =>
  created(res, serializeIcdCode(await icd.create(req.user.id, req.body)), "ICD code added")
);

exports.update = asyncHandler(async (req, res) =>
  ok(res, serializeIcdCode(await icd.update(req.user.id, req.params.id, req.body)), "ICD code updated")
);

exports.importRows = asyncHandler(async (req, res) =>
  ok(res, await icd.importRows(req.user.id, req.body), req.body.dryRun ? "Import checked" : "Import finished")
);

// ── Excel import (migration 060) ─────────────────────────────────────────────
exports.excelTemplate = asyncHandler(async (_req, res) => sendFile(res, await icdImport.template(), { download: true }));

exports.excelPreview = asyncHandler(async (req, res) => ok(res, await icdImport.preview(req.file, req.body), "File checked — nothing saved yet"));

exports.excelCommit = asyncHandler(async (req, res) => {
  const result = await icdImport.commit(req.user.id, req.file, req.body);
  return ok(res, result, `${result.counts.inserted} added, ${result.counts.updated} updated`);
});

exports.importHistory = asyncHandler(async (req, res) => ok(res, await icdImport.history(req.validatedQuery), "Import history"));

exports.doctorEntries = asyncHandler(async (req, res) =>
  ok(res, await icd.doctorEntries(req.validatedQuery), "Diagnoses recorded without a master code")
);
