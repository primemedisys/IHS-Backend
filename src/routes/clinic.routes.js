/**
 * /doctor clinics + availability routes (PRD §4.3a). Mounted under `/doctor`
 * alongside doctor.routes.js. Every route is guarded `authenticate` +
 * `authorize('doctor')`; validation is declared HERE so controllers stay thin.
 *
 * Weekly schedules (clinic + online) are replace-the-set: a single PUT swaps the
 * whole week (validated by `setAvailability`).
 */
const router = require("express").Router();

const clinic = require("../controllers/clinic.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const schema = require("../validators/clinic.validator");
const { ROLES } = require("../config/constants");

// resolveDoctorId('self') sets req.doctorId = req.user.id (the shared clinic
// controllers are also mounted under /admin/doctors/:doctorId/*).
const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

// ── Clinics ──────────────────────────────────────────────────────────────────
router
  .route("/clinics")
  .all(...guard)
  .get(clinic.listClinics)
  .post(validate(schema.createClinic), clinic.addClinic);

router
  .route("/clinics/:id")
  .all(...guard)
  .get(clinic.getClinic)
  .patch(validate(schema.updateClinic), clinic.updateClinic)
  .delete(clinic.removeClinic);

// ── Per-clinic weekly availability (replace-the-set) ─────────────────────────
router
  .route("/clinics/:id/availability")
  .all(...guard)
  .get(clinic.getClinicAvailability)
  .put(validate(schema.setAvailability), clinic.setClinicAvailability);

// ── Independent online/video availability (replace-the-set) ──────────────────
router
  .route("/online-availability")
  .all(...guard)
  .get(clinic.getOnlineAvailability)
  .put(validate(schema.setAvailability), clinic.setOnlineAvailability);

// ── Blocked-date exceptions ──────────────────────────────────────────────────
router
  .route("/exceptions")
  .all(...guard)
  .get(clinic.listExceptions)
  .post(validate(schema.createException), clinic.addException);
router.delete("/exceptions/:id", ...guard, clinic.removeException);

module.exports = router;
