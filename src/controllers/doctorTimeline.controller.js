/**
 * A doctor reading a patient's treatment timeline (docs/treatment-timeline
 * §5.3/§5.4). Two entry points with two different gates, both enforced in the
 * service before any patient data loads:
 *
 *   listByBooking  — from an appointment / a live video call. The patient is
 *                    DERIVED from a booking the doctor owns, so no patient can
 *                    be named by the caller.
 *   listByPatient  — from the My Patients roster. The caller names a patient,
 *                    so the treating relationship is asserted first.
 *
 * Both serialize with `viewer: "doctor"`, which omits prescription ids
 * (README §7-A).
 */
const timelineService = require("../services/treatmentTimeline.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeTimeline, serializeDoctorPatients } = require("../utils/serializers");

const asDoctor = { viewer: "doctor" };

exports.listByBooking = asyncHandler(async (req, res) => {
  const result = await timelineService.listByBooking(req.doctorId, req.params.id, req.validatedQuery);
  return ok(res, serializeTimeline(result, asDoctor), "Patient treatment timeline");
});

exports.listByPatient = asyncHandler(async (req, res) => {
  const result = await timelineService.listByPatient(
    req.doctorId,
    req.params.patientId,
    req.validatedQuery
  );
  return ok(res, serializeTimeline(result, asDoctor), "Patient treatment timeline");
});

exports.setPatientStatus = asyncHandler(async (req, res) => {
  const status = await timelineService.setPatientStatus(
    req.doctorId,
    req.params.patientId,
    req.body.status
  );
  return ok(res, { status }, "Patient status updated");
});

exports.listPatients = asyncHandler(async (req, res) => {
  const result = await timelineService.listDoctorPatients(req.doctorId, req.validatedQuery ?? {});
  return ok(res, serializeDoctorPatients(result), "My patients");
});
