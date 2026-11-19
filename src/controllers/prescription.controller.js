/**
 * Doctor-facing prescription controllers — thin. Ownership is enforced in the
 * service's WHERE clause, so nothing here checks it.
 */
const prescriptionService = require("../services/prescription.service");
const uploadService = require("../services/upload.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok, created } = require("../utils/apiResponse");
const {
  serializePrescriptionForDoctor,
  serializePrescriptionSummary,
} = require("../utils/serializers");
const { ERROR_CODES, PRESCRIPTION_STATUS } = require("../config/constants");

const RX_STATUSES = Object.values(PRESCRIPTION_STATUS);
const asId = (v) => (/^\d+$/.test(String(v ?? "")) ? String(v) : undefined);

exports.list = asyncHandler(async (req, res) => {
  const rows = await prescriptionService.listForDoctor(req.doctorId, {
    status: RX_STATUSES.includes(req.query.status) ? req.query.status : undefined,
    patientId: asId(req.query.patientId),
    bookingId: asId(req.query.bookingId),
  });
  return ok(res, rows.map(serializePrescriptionSummary), "Prescriptions");
});

exports.create = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.createDraft(req.doctorId, req.body);
  return created(res, serializePrescriptionForDoctor(rx), "Draft prescription created");
});

exports.getOne = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.getOne(req.doctorId, req.params.id);
  return ok(res, serializePrescriptionForDoctor(rx), "Prescription");
});

/** The appointment screen's one-shot "Write Rx" vs "View Rx" check. */
exports.byBooking = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.getByBooking(req.doctorId, req.params.id);
  return ok(res, serializePrescriptionForDoctor(rx), "Prescription");
});

exports.update = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.patch(req.doctorId, req.params.id, req.body);
  return ok(res, serializePrescriptionForDoctor(rx), "Draft saved");
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await prescriptionService.remove(req.doctorId, req.params.id);
  return ok(res, result, "Draft discarded");
});

/** Refresh a draft from its Patient Workbench consultation (migration 059). */
exports.syncWorkbench = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.syncWorkbench(req.doctorId, req.params.id);
  return ok(res, serializePrescriptionForDoctor(rx), "Prescription refreshed from the Patient Workbench");
});

exports.finalize = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.finalize(req.doctorId, req.params.id, req.body);
  return ok(res, serializePrescriptionForDoctor(rx), "Prescription finalized");
});

exports.amend = asyncHandler(async (req, res) => {
  const rx = await prescriptionService.amend(req.doctorId, req.params.id, req.body);
  return created(res, serializePrescriptionForDoctor(rx), "Amendment started");
});

/**
 * Stream the stored PDF rather than redirecting to the object URL, so ownership
 * is re-checked on every download. `pdfUrlFor` self-heals a finalized row whose
 * render failed earlier.
 */
async function streamPdf(res, { url, rxNumber }) {
  const buffer = await uploadService.readByUrl(url);
  if (!buffer) {
    throw new ApiError(500, "The prescription PDF could not be read", {
      code: ERROR_CODES.PDF_RENDER_FAILED,
    });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${rxNumber || "prescription"}.pdf"`);
  return res.send(buffer);
}
exports.streamPdf = streamPdf;

exports.pdf = asyncHandler(async (req, res) => {
  const result = await prescriptionService.getPdfForDoctor(req.doctorId, req.params.id);
  return streamPdf(res, result);
});
