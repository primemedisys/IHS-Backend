/**
 * The patient's read-only view of their prescriptions. Drafts are never
 * returned — the service hard-filters `status='finalized'`.
 */
const prescriptionService = require("../services/prescription.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializePrescriptionForPatient } = require("../utils/serializers");
const { streamPdf } = require("./prescription.controller");

exports.list = asyncHandler(async (req, res) => {
  const rows = await prescriptionService.listForPatient(req.user.id);
  return ok(res, rows.map(serializePrescriptionForPatient), "Prescriptions");
});

exports.getOne = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.getOneForPatient(req.user.id, req.params.id);
  return ok(res, serializePrescriptionForPatient(rx), "Prescription");
});

exports.pdf = asyncHandler(async (req, res) => {
  const result = await prescriptionService.getPdfForPatient(req.user.id, req.params.id);
  return streamPdf(res, result);
});
