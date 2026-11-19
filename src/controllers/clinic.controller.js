/**
 * Doctor-owned clinics + availability controllers — deliberately THIN. Each
 * handler reads validated input + `req.doctorId` (+ `req.params.id`), calls
 * exactly one service function, and serializes. No business rules / DB calls.
 */
const clinicService = require("../services/clinic.service");
const availabilityService = require("../services/availability.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeOwnClinic,
  serializeWeeklySlot,
  serializeException,
} = require("../utils/serializers");

// ── Clinics ──────────────────────────────────────────────────────────────────
exports.listClinics = asyncHandler(async (req, res) => {
  const rows = await clinicService.listClinics(req.doctorId);
  return ok(res, rows.map(serializeOwnClinic), "Your clinics");
});
exports.getClinic = asyncHandler(async (req, res) => {
  const clinic = await clinicService.getClinic(req.doctorId, req.params.id);
  return ok(res, serializeOwnClinic(clinic), "Clinic");
});
exports.addClinic = asyncHandler(async (req, res) => {
  const clinic = await clinicService.addClinic(req.doctorId, req.body);
  return created(res, serializeOwnClinic(clinic), "Clinic added");
});
exports.updateClinic = asyncHandler(async (req, res) => {
  const clinic = await clinicService.updateClinic(req.doctorId, req.params.id, req.body);
  return ok(res, serializeOwnClinic(clinic), "Clinic updated");
});
exports.removeClinic = asyncHandler(async (req, res) => {
  await clinicService.removeClinic(req.doctorId, req.params.id);
  return ok(res, null, "Clinic removed");
});

// ── Clinic availability (replace-the-set) ────────────────────────────────────
exports.getClinicAvailability = asyncHandler(async (req, res) => {
  const rows = await availabilityService.getClinicAvailability(req.doctorId, req.params.id);
  return ok(res, rows.map(serializeWeeklySlot), "Clinic availability");
});
exports.setClinicAvailability = asyncHandler(async (req, res) => {
  const rows = await availabilityService.setClinicAvailability(
    req.doctorId,
    req.params.id,
    req.body.slots
  );
  return ok(res, rows.map(serializeWeeklySlot), "Clinic availability updated");
});

// ── Online availability (replace-the-set) ────────────────────────────────────
exports.getOnlineAvailability = asyncHandler(async (req, res) => {
  const rows = await availabilityService.getOnlineAvailability(req.doctorId);
  return ok(res, rows.map(serializeWeeklySlot), "Online availability");
});
exports.setOnlineAvailability = asyncHandler(async (req, res) => {
  const rows = await availabilityService.setOnlineAvailability(req.doctorId, req.body.slots);
  return ok(res, rows.map(serializeWeeklySlot), "Online availability updated");
});

// ── Exceptions ───────────────────────────────────────────────────────────────
exports.listExceptions = asyncHandler(async (req, res) => {
  const rows = await availabilityService.listExceptions(req.doctorId);
  return ok(res, rows.map(serializeException), "Exceptions");
});
exports.addException = asyncHandler(async (req, res) => {
  const row = await availabilityService.addException(req.doctorId, req.body);
  return created(res, serializeException(row), "Exception added");
});
exports.removeException = asyncHandler(async (req, res) => {
  await availabilityService.removeException(req.doctorId, req.params.id);
  return ok(res, null, "Exception removed");
});
