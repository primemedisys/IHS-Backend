/**
 * Doctor record-access consent (migration 045). Thin: the actor is ALWAYS the
 * authenticated user (req.user.id / req.doctorId), never an id from the body.
 */
const service = require("../services/doctorRecordAccess.service");
const asyncHandler = require("../utils/asyncHandler");
const sendFile = require("../utils/sendFile");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeAccessRequestForDoctor,
  serializeAccessRequestForPatient,
  serializeAccessRequestPage,
  serializeDoctorPatientSearch,
  serializeDoctorPatientCard,
} = require("../utils/serializers");

/** Who did it, for the audit log. */
const ctx = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

// ── Doctor ────────────────────────────────────────────────────────────────────
exports.searchPatients = asyncHandler(async (req, res) =>
  ok(res, serializeDoctorPatientSearch(await service.searchPatients(req.doctorId, req.validatedQuery, ctx(req))), "Patients")
);

exports.patientCard = asyncHandler(async (req, res) =>
  ok(res, serializeDoctorPatientCard(await service.getPatientForDoctor(req.doctorId, req.params.patientId, ctx(req))), "Patient")
);

exports.create = asyncHandler(async (req, res) =>
  created(res, serializeAccessRequestForDoctor(await service.createRequest(req.doctorId, req.body, ctx(req))), "Request sent to the patient")
);

exports.listForDoctor = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestPage(await service.listForDoctor(req.doctorId, req.validatedQuery), serializeAccessRequestForDoctor), "Access requests")
);

exports.getForDoctor = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestForDoctor(await service.getForDoctor(req.doctorId, req.params.id)), "Access request")
);

exports.cancel = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestForDoctor(await service.cancelForDoctor(req.doctorId, req.params.id, ctx(req))), "Request withdrawn")
);

exports.recordFile = asyncHandler(async (req, res) =>
  sendFile(res, await service.streamRecordForDoctor(req.doctorId, req.params.id, req.params.recordId, ctx(req)))
);

// ── Patient ───────────────────────────────────────────────────────────────────
exports.listForPatient = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestPage(await service.listForPatient(req.user.id, req.validatedQuery), (r) => serializeAccessRequestForPatient(r)), "Access requests")
);

exports.getForPatient = asyncHandler(async (req, res) => {
  const { request, candidates } = await service.getForPatient(req.user.id, req.params.id);
  return ok(res, serializeAccessRequestForPatient(request, candidates), "Access request");
});

exports.approve = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestForPatient(await service.approve(req.user.id, req.params.id, req.body, ctx(req))), "Access approved")
);

exports.reject = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestForPatient(await service.reject(req.user.id, req.params.id, req.body, ctx(req))), "Request declined")
);

exports.revoke = asyncHandler(async (req, res) =>
  ok(res, serializeAccessRequestForPatient(await service.revoke(req.user.id, req.params.id, ctx(req))), "Access revoked")
);
