/**
 * /admin doctor-MANAGEMENT routes (distinct from the verification queue in
 * adminDoctor.routes.js). Two things live here:
 *   1. POST /admin/doctors            — create + auto-approve a doctor.
 *   2. /admin/doctors/:doctorId/*      — the FULL doctor write surface, reusing
 *      the same doctor.controller + clinic.controller handlers the owner uses.
 *      `resolveDoctorId('param')` sets req.doctorId = :doctorId, so the shared
 *      controllers act on the target doctor with ZERO duplicated logic
 *      (docs/admin-portal/backend-plan.md §3).
 *
 * Param convention: `:doctorId` is the doctor; child-row ids stay `:id` (the
 * reused controllers read child ids from req.params.id).
 *
 * Upload order matters (mirrors doctor.routes.js): upload.single('file') runs
 * BEFORE validate(...) so the multipart text fields exist when Joi checks them.
 */
const router = require("express").Router();

const doctor = require("../controllers/doctor.controller"); // REUSED
const clinic = require("../controllers/clinic.controller"); // REUSED
const adminManage = require("../controllers/adminDoctorManage.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const upload = require("../middlewares/upload");
const schema = require("../validators/doctor.validator");
const clinicSchema = require("../validators/clinic.validator");
const adminSchema = require("../validators/admin.validator");
const { ROLES } = require("../config/constants");

const adminGuard = [authenticate, authorize(ROLES.ADMIN)];
// For every /doctors/:doctorId/* route: admin-guarded + target resolved to req.doctorId.
const onDoctor = [...adminGuard, resolveDoctorId("param")];

// ── Create + auto-approve ─────────────────────────────────────────────────────
router.post("/doctors", ...adminGuard, validate(adminSchema.createDoctor), adminManage.create);

// ── Profile / onboarding / preview ────────────────────────────────────────────
router.get("/doctors/:doctorId/onboarding", ...onDoctor, doctor.onboarding);
router.get("/doctors/:doctorId/profile", ...onDoctor, doctor.getProfile);
router.patch("/doctors/:doctorId/profile", ...onDoctor, validate(schema.updateProfile), doctor.updateProfile);
router.get("/doctors/:doctorId/preview", ...onDoctor, doctor.preview);

// ── Specializations / languages (replace-the-set) ─────────────────────────────
router.put("/doctors/:doctorId/specializations", ...onDoctor, validate(schema.setSpecializations), doctor.setSpecializations);
router.put("/doctors/:doctorId/languages", ...onDoctor, validate(schema.setLanguages), doctor.setLanguages);

// ── Awards / links / keywords (1:M) ───────────────────────────────────────────
router
  .route("/doctors/:doctorId/awards")
  .all(...onDoctor)
  .get(doctor.listAwards)
  .post(validate(schema.createAward), doctor.addAward);
router.delete("/doctors/:doctorId/awards/:id", ...onDoctor, doctor.removeAward);

router
  .route("/doctors/:doctorId/links")
  .all(...onDoctor)
  .get(doctor.listLinks)
  .post(validate(schema.createLink), doctor.addLink);
router.delete("/doctors/:doctorId/links/:id", ...onDoctor, doctor.removeLink);

router
  .route("/doctors/:doctorId/keywords")
  .all(...onDoctor)
  .get(doctor.listKeywords)
  .post(validate(schema.createKeyword), doctor.addKeyword);
router.delete("/doctors/:doctorId/keywords/:id", ...onDoctor, doctor.removeKeyword);

// ── Documents / photo (multipart) ─────────────────────────────────────────────
router.get("/doctors/:doctorId/documents", ...onDoctor, doctor.listDocuments);
router.post("/doctors/:doctorId/documents", ...onDoctor, upload.single("file"), validate(schema.uploadDocument), doctor.uploadDocument);
router.delete("/doctors/:doctorId/documents/:id", ...onDoctor, doctor.removeDocument);

router.post("/doctors/:doctorId/photo", ...onDoctor, upload.single("file"), doctor.uploadPhoto);

// ── Portfolio v2 owned sections — reuse the SAME key→schema loop as doctor.routes.js ─
const OWNED_SECTIONS = {
  education: schema.createEducation,
  experience: schema.createExperience,
  services: schema.createService,
  publications: schema.createPublication,
  memberships: schema.createMembership,
  faqs: schema.createFaq,
};
for (const [key, createSchema] of Object.entries(OWNED_SECTIONS)) {
  const h = doctor[key];
  router
    .route(`/doctors/:doctorId/${key}`)
    .all(...onDoctor)
    .get(h.list)
    .post(validate(createSchema), h.add);
  router
    .route(`/doctors/:doctorId/${key}/:id`)
    .all(...onDoctor)
    .patch(validate(schema.partialOf(createSchema)), h.update)
    .delete(h.remove);
}

// ── Gallery (multipart) + insurances (M:N) ────────────────────────────────────
router
  .route("/doctors/:doctorId/gallery")
  .all(...onDoctor)
  .get(doctor.listGallery)
  .post(upload.single("file"), validate(schema.uploadGallery), doctor.addGallery);
router.delete("/doctors/:doctorId/gallery/:id", ...onDoctor, doctor.removeGallery);

router.put("/doctors/:doctorId/insurances", ...onDoctor, validate(schema.setInsurances), doctor.setInsurances);

// ── Clinics + availability (reuse clinic.controller) ──────────────────────────
router
  .route("/doctors/:doctorId/clinics")
  .all(...onDoctor)
  .get(clinic.listClinics)
  .post(validate(clinicSchema.createClinic), clinic.addClinic);
router
  .route("/doctors/:doctorId/clinics/:id")
  .all(...onDoctor)
  .get(clinic.getClinic)
  .patch(validate(clinicSchema.updateClinic), clinic.updateClinic)
  .delete(clinic.removeClinic);
router
  .route("/doctors/:doctorId/clinics/:id/availability")
  .all(...onDoctor)
  .get(clinic.getClinicAvailability)
  .put(validate(clinicSchema.setAvailability), clinic.setClinicAvailability);

router
  .route("/doctors/:doctorId/online-availability")
  .all(...onDoctor)
  .get(clinic.getOnlineAvailability)
  .put(validate(clinicSchema.setAvailability), clinic.setOnlineAvailability);

router
  .route("/doctors/:doctorId/exceptions")
  .all(...onDoctor)
  .get(clinic.listExceptions)
  .post(validate(clinicSchema.createException), clinic.addException);
router.delete("/doctors/:doctorId/exceptions/:id", ...onDoctor, clinic.removeException);

module.exports = router;
