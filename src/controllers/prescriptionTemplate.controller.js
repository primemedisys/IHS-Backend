/**
 * Letterhead template controllers — thin. Read `req.doctorId` (set by
 * resolveDoctorId) + validated input, call one service function, serialize.
 */
const templateService = require("../services/prescriptionTemplate.service");
const pdfService = require("../services/prescriptionPdf.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { serializeTemplate, serializeTemplateSummary } = require("../utils/serializers");
const { snapshotOf } = require("../services/prescription.service");

exports.list = asyncHandler(async (req, res) => {
  const rows = await templateService.list(req.doctorId);
  return ok(res, rows.map(serializeTemplateSummary), "Prescription templates");
});

exports.create = asyncHandler(async (req, res) => {
  const row = await templateService.create(req.doctorId, req.body);
  return created(res, serializeTemplate(row), "Template created");
});

exports.getOne = asyncHandler(async (req, res) => {
  const row = await templateService.getOne(req.doctorId, req.params.id);
  return ok(res, serializeTemplate(row), "Template");
});

exports.update = asyncHandler(async (req, res) => {
  const row = await templateService.update(req.doctorId, req.params.id, req.body);
  return ok(res, serializeTemplate(row), "Template updated");
});

exports.remove = asyncHandler(async (req, res) => {
  await templateService.remove(req.doctorId, req.params.id);
  return ok(res, { id: String(req.params.id) }, "Template deleted");
});

exports.setDefault = asyncHandler(async (req, res) => {
  const row = await templateService.setDefault(req.doctorId, req.params.id);
  return ok(res, serializeTemplate(row), "Default letterhead updated");
});

exports.duplicate = asyncHandler(async (req, res) => {
  const row = await templateService.duplicate(req.doctorId, req.params.id, req.body);
  return created(res, serializeTemplate(row), "Template duplicated");
});

exports.putAsset = asyncHandler(async (req, res) => {
  const row = await templateService.putAsset(req.doctorId, req.params.id, req.body.kind, req.file);
  return ok(res, serializeTemplate(row), `${req.body.kind} updated`);
});

exports.removeAsset = asyncHandler(async (req, res) => {
  const row = await templateService.removeAsset(req.doctorId, req.params.id, req.params.kind);
  return ok(res, serializeTemplate(row), `${req.params.kind} removed`);
});

/**
 * Render the letterhead against sample patient data. Never stored — this is the
 * editor's "Preview PDF", and it is the authority on what the page looks like.
 */
exports.previewPdf = asyncHandler(async (req, res) => {
  const template = await templateService.getOne(req.doctorId, req.params.id);
  const buffer = await pdfService.renderSample(snapshotOf(template));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="letterhead-preview.pdf"');
  res.setHeader("Cache-Control", "no-store");
  return res.send(buffer);
});
