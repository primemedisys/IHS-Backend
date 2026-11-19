/**
 * /admin registry routes — every registered doctor / patient (newest first),
 * one patient deep-read, and an admin record upload on a patient's behalf.
 * Distinct from the verification queue (adminDoctor.routes.js): that lists
 * who is AWAITING a verdict, this lists who EXISTS.
 *
 * Upload order matters (mirrors patient.routes.js): upload.single('file') runs
 * BEFORE validate(...) so the multipart text fields exist when Joi checks them.
 */
const router = require("express").Router();

const registry = require("../controllers/adminRegistry.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const upload = require("../middlewares/upload");
const patientSchema = require("../validators/patient.validator");
const adminSchema = require("../validators/admin.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/registry/doctors", ...guard, registry.listDoctors);
router.get("/registry/patients", ...guard, registry.listPatients);
router.get("/registry/patients/:id", ...guard, registry.getPatient);
// What erasing this patient would destroy — read before the confirm dialog.
router.get("/registry/patients/:id/deletion-preview", ...guard, registry.deletionPreview);
// Erase the patient and everything that makes them visible anywhere. The body
// must echo their name back; see the controller.
router.delete("/registry/patients/:id", ...guard, registry.deletePatient);
router.post(
  "/registry/patients/:id/records",
  ...guard,
  upload.single("file"),
  validate(patientSchema.uploadRecord),
  registry.uploadPatientRecord
);

// ── Doctor deletion / deactivation (admin only) ──────────────────────
// What erasing this doctor would destroy — read before the confirm dialog.
router.get("/registry/doctors/:id/deletion-preview", ...guard, validate(adminSchema.doctorIdParams, "params"), registry.doctorDeletionPreview);
// Erase a rejected doctor and everything that makes them visible anywhere.
// The body must echo the doctor's name back; see the controller.
router.delete("/registry/doctors/:id", ...guard, validate(adminSchema.doctorIdParams, "params"), validate(adminSchema.deleteDoctor), registry.deleteDoctor);
// Deactivate / reactivate (archive): keeps every record, blocks sign-in, unlists.
router.patch("/registry/doctors/:id/active", ...guard, validate(adminSchema.doctorIdParams, "params"), validate(adminSchema.setDoctorActive), registry.setDoctorActive);

module.exports = router;
