/**
 * Admin registry controllers — deliberately THIN. The lists come from
 * adminRegistry.service; the patient deep-read and the record upload REUSE
 * patient.service, so the admin sees exactly what the patient sees and an
 * admin upload follows the same code path as the patient's own (stamped
 * source 'admin' + the admin's user id for the provenance chip).
 */
const { User } = require("../models");
const registryService = require("../services/adminRegistry.service");
const patientService = require("../services/patient.service");
const vitalsService = require("../services/patientVitals.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok, created } = require("../utils/apiResponse");
const { RECORD_SOURCES, ERROR_CODES } = require("../config/constants");
const {
  serializeRegisteredDoctor,
  serializeRegisteredPatient,
  serializePatientProfile,
  serializePatientVitals,
  serializeUploadedRecord,
  serializeAllergyEntry,
  serializeConditionEntry,
  serializeMedication,
} = require("../utils/serializers");

exports.listDoctors = asyncHandler(async (req, res) => {
  const rows = await registryService.listDoctors({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
    minExperience: req.query.minExperience,
    maxExperience: req.query.maxExperience,
    location: req.query.location,
  });
  const serialized = rows.map(serializeRegisteredDoctor);
  return ok(res, serialized, "Registered doctors");
});

exports.listPatients = asyncHandler(async (req, res) => {
  const rows = await registryService.listPatients({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
    gender: req.query.gender,
    location: req.query.location,
    conditionName: req.query.conditionName,
  });
  // Batch-fetch chronic conditions for all listed patients.
  const ids = rows.map((r) => r.id);
  const condMap = await registryService.patientConditions(ids);
  const serialized = rows.map((r) => serializeRegisteredPatient(r, { conditions: condMap[String(r.id)] ?? [] }));
  return ok(res, serialized, "Registered patients");
});

/**
 * One patient, WHOLE: profile (with the completeness the patient sees), their
 * reported history, uploaded records, the vitals matrix, and the per-bucket
 * record counts the "uploaded vs. remaining" checklist is drawn from.
 *
 * One round trip on purpose — the admin reads this page top to bottom, and six
 * separate requests would paint it in six stages.
 */
exports.getPatient = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await registryService.assertPatient(id);
  const [user, records, vitals, counts, allergies, conditions, medications] = await Promise.all([
    patientService.getProfile(id),
    patientService.getRecords(id),
    vitalsService.listForPatient(id),
    registryService.recordCounts(id),
    patientService.getAllergies(id),
    patientService.getConditions(id),
    patientService.getMedications(id),
  ]);
  const status = patientService.computeProfileStatus(user);
  const completion = await patientService.computeProfileCompletion(user);
  return ok(
    res,
    {
      profile: serializePatientProfile(user, status, completion),
      allergies: allergies.map(serializeAllergyEntry),
      conditions: conditions.map(serializeConditionEntry),
      medications: medications.map(serializeMedication),
      records: records.map(serializeUploadedRecord),
      vitals: serializePatientVitals(vitals.rows, { age: vitals.age }),
      recordCounts: counts,
    },
    "Patient"
  );
});

/** Upload a record on the patient's behalf (multipart), stamped source 'admin'. */
exports.uploadPatientRecord = asyncHandler(async (req, res) => {
  await registryService.assertPatient(req.params.id);
  const row = await patientService.uploadRecord(req.params.id, req.file, req.body, {
    source: RECORD_SOURCES.ADMIN,
    userId: req.user.id,
  });
  return created(res, serializeUploadedRecord(row), "Record uploaded");
});

/**
 * What deleting this patient would destroy — read BEFORE the confirm dialog, so
 * the admin is shown the consultations, prescriptions and notes at stake rather
 * than a generic "are you sure".
 */
exports.deletionPreview = asyncHandler(async (req, res) => {
  await registryService.assertPatient(req.params.id);
  const counts = await registryService.deletionPreview(req.params.id);
  return ok(res, counts, "Deletion preview");
});

/**
 * Erase a patient from the platform. Irreversible, and it removes rows DOCTORS
 * authored, so the admin must echo the patient's name back — a mis-click on a
 * roster row must not be able to do this.
 */
exports.deletePatient = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await registryService.assertPatient(id);

  const user = await User.findByPk(id, { attributes: ["id", "name"] });
  const typed = String(req.body?.confirmName ?? "").trim().toLowerCase();
  if (!typed || typed !== String(user.name ?? "").trim().toLowerCase()) {
    throw new ApiError(422, "Type the patient's name exactly to confirm", {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }

  const destroyed = await registryService.deletePatient(id);
  // The one action worth a server-side record of its own: who erased whom.
  console.warn(
    `[admin] patient ${id} (${user.name}) deleted by admin ${req.user.id} — ${JSON.stringify(destroyed)}`
  );
  return ok(res, { id: String(id), destroyed }, "Patient deleted");
});

// ── Doctor deletion (admin only, rejected doctors only) ──────────────────────

/**
 * What deleting this doctor would destroy — read BEFORE the confirm dialog.
 */
exports.doctorDeletionPreview = asyncHandler(async (req, res) => {
  await registryService.assertDoctor(req.params.id);
  const counts = await registryService.doctorDeletionPreview(req.params.id);
  return ok(res, counts, "Deletion preview");
});

/**
 * Permanently delete a doctor ACCOUNT that has no clinical or financial history.
 * Irreversible. Admin-only (router guard); the typed phrase is validated by Joi.
 * A doctor with any dependent record gets 409 from the service — use deactivate.
 */
exports.deleteDoctor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (String(id) === String(req.user.id)) throw ApiError.forbidden("You cannot delete your own account");
  const user = await registryService.assertDoctor(id);
  const destroyed = await registryService.deleteDoctor(id, { adminId: req.user.id, ip: req.ip });
  console.warn(`[admin] doctor ${id} (${user.name}) permanently deleted by admin ${req.user.id}`);
  return ok(res, { id: String(id) }, "Doctor deleted");
});

/** Deactivate / reactivate a doctor account (nothing is deleted). */
exports.setDoctorActive = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (String(id) === String(req.user.id)) throw ApiError.forbidden("You cannot change your own account");
  const result = await registryService.setDoctorActive(id, req.body.isActive, { adminId: req.user.id, ip: req.ip });
  console.warn(`[admin] doctor ${id} ${result.isActive ? "reactivated" : "deactivated"} by admin ${req.user.id}`);
  return ok(res, { id: String(id), ...result }, result.isActive ? "Doctor reactivated" : "Doctor deactivated");
});
