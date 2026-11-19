/**
 * Admin doctor-management controller — THIN. Only the create-a-doctor handler is
 * here; every *editing* endpoint under `/admin/doctors/:doctorId/*` reuses the
 * shared `doctor.controller` handlers (they read `req.doctorId`, set by
 * `resolveDoctorId('param')`). Verification queue/verdict live in
 * `adminDoctor.controller`.
 */
const adminDoctorService = require("../services/adminDoctor.service");
const asyncHandler = require("../utils/asyncHandler");
const { created } = require("../utils/apiResponse");
const { serializeDoctorProfile } = require("../utils/serializers");

exports.create = asyncHandler(async (req, res) => {
  const profile = await adminDoctorService.createDoctor(req.body);
  return created(res, serializeDoctorProfile(profile), "Doctor created and approved");
});
