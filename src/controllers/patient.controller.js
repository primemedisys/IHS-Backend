/**
 * Patient-owned profile + health-record controllers — deliberately THIN. Each
 * handler reads validated input + `req.user.id`, calls exactly one service
 * function, and serializes. No business rules / DB calls here.
 */
const patientService = require("../services/patient.service");
const vitalsService = require("../services/patientVitals.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializePatientProfile,
  serializePatientVitals,
  serializeAllergyEntry,
  serializeConditionEntry,
  serializeMedication,
  serializeUploadedRecord,
  serializeUser,
} = require("../utils/serializers");

/** Load the profile, its boolean gate, and the weighted completion, together. */
async function profilePayload(userId) {
  const user = await patientService.getProfile(userId);
  const status = patientService.computeProfileStatus(user);
  const completion = await patientService.computeProfileCompletion(user);
  return serializePatientProfile(user, status, completion);
}

exports.getProfile = asyncHandler(async (req, res) => {
  return ok(res, await profilePayload(req.user.id), "Your profile");
});

exports.updateProfile = asyncHandler(async (req, res) => {
  await patientService.updateProfile(req.user.id, req.body);
  return ok(res, await profilePayload(req.user.id), "Profile updated");
});

// ── Allergies (replace-set) ──────────────────────────────────────────────────
exports.getAllergies = asyncHandler(async (req, res) => {
  const rows = await patientService.getAllergies(req.user.id);
  return ok(res, rows.map(serializeAllergyEntry), "Allergies");
});

exports.setAllergies = asyncHandler(async (req, res) => {
  const rows = await patientService.setAllergies(req.user.id, req.body);
  return ok(res, rows.map(serializeAllergyEntry), "Allergies updated");
});

// ── Conditions (replace-set) ─────────────────────────────────────────────────
exports.getConditions = asyncHandler(async (req, res) => {
  const rows = await patientService.getConditions(req.user.id);
  return ok(res, rows.map(serializeConditionEntry), "Conditions");
});

exports.setConditions = asyncHandler(async (req, res) => {
  const rows = await patientService.setConditions(req.user.id, req.body);
  return ok(res, rows.map(serializeConditionEntry), "Conditions updated");
});

// ── Current medications (per-item) ───────────────────────────────────────────
exports.getMedications = asyncHandler(async (req, res) => {
  const rows = await patientService.getMedications(req.user.id);
  return ok(res, rows.map(serializeMedication), "Medications");
});

exports.addMedication = asyncHandler(async (req, res) => {
  const row = await patientService.addMedication(req.user.id, req.body);
  return created(res, serializeMedication(row), "Medication added");
});

exports.updateMedication = asyncHandler(async (req, res) => {
  const row = await patientService.updateMedication(req.user.id, req.params.id, req.body);
  return ok(res, serializeMedication(row), "Medication updated");
});

exports.setNoCurrentMedications = asyncHandler(async (req, res) => {
  const rows = await patientService.setNoCurrentMedications(req.user.id, req.body.noCurrentMedications);
  return ok(res, rows.map(serializeMedication), "Medications updated");
});

exports.deleteMedication = asyncHandler(async (req, res) => {
  await patientService.deleteMedication(req.user.id, req.params.id);
  return ok(res, null, "Medication removed");
});

// ── Uploaded records (per-item) ──────────────────────────────────────────────
exports.getRecords = asyncHandler(async (req, res) => {
  // The patient's own list is the ONLY read that includes identity documents.
  const rows = await patientService.getRecords(req.user.id, { includeIdentity: true });
  return ok(res, rows.map(serializeUploadedRecord), "Records");
});

exports.addRecord = asyncHandler(async (req, res) => {
  const row = await patientService.addRecord(req.user.id, req.body);
  return created(res, serializeUploadedRecord(row), "Record added");
});

exports.uploadRecord = asyncHandler(async (req, res) => {
  const row = await patientService.uploadRecord(req.user.id, req.file, req.body);
  return created(res, serializeUploadedRecord(row), "Report uploaded");
});

// Profile photo → users.profile_photo_url (the avatar every surface renders).
exports.uploadPhoto = asyncHandler(async (req, res) => {
  const user = await patientService.uploadPhoto(req.user.id, req.file);
  return ok(res, serializeUser(user), "Photo updated");
});

exports.updateRecord = asyncHandler(async (req, res) => {
  const row = await patientService.updateRecord(req.user.id, req.params.id, req.body);
  return ok(res, serializeUploadedRecord(row), "Record updated");
});

// Swap the file behind one of the patient's own documents (details kept).
exports.replaceRecordFile = asyncHandler(async (req, res) => {
  const row = await patientService.replaceRecordFile(req.user.id, req.params.id, req.file);
  return ok(res, serializeUploadedRecord(row), "Document replaced");
});

exports.deleteRecord = asyncHandler(async (req, res) => {
  await patientService.deleteRecord(req.user.id, req.params.id);
  return ok(res, null, "Record removed");
});

// ── Vitals timeline (the record table) ───────────────────────────────────────
// `age` rides along so the serializer can band each reading against the adult
// reference ranges (docs/vitals-reference-ranges §4).
exports.getVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await vitalsService.listForPatient(req.user.id);
  return ok(res, serializePatientVitals(rows, { age }), "Vitals");
});

exports.addVitals = asyncHandler(async (req, res) => {
  const { rows, age } = await vitalsService.addForPatient(req.user.id, req.body);
  return created(res, serializePatientVitals(rows, { age }), "Reading added");
});
