/**
 * /doctor — patient search + record-access consent (migration 045).
 *
 *   authenticate → authorize(doctor) → resolveDoctorId(self) → [rate limit] → validate → controller
 *
 * The service additionally requires an APPROVED doctor for search and
 * requests, re-checks the grant on every file read, and audits each action.
 */
const router = require("express").Router();
const controller = require("../controllers/recordAccess.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { patientSearchLimiter, accessRequestLimiter, pdfLimiter } = require("../middlewares/rateLimiters");
const schema = require("../validators/recordAccess.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

// Find a patient the doctor does NOT already treat (basic, non-medical fields).
router.get("/patient-search", ...guard, patientSearchLimiter, validateQuery(schema.patientSearch), controller.searchPatients);
router.get(
  "/patient-search/:patientId",
  ...guard,
  patientSearchLimiter,
  validate(schema.patientIdParam, "params"),
  controller.patientCard
);

router.post("/access-requests", ...guard, accessRequestLimiter, validate(schema.createAccessRequest), controller.create);
router.get("/access-requests", ...guard, validateQuery(schema.doctorListQuery), controller.listForDoctor);
router.get("/access-requests/:id", ...guard, validate(schema.idParam, "params"), controller.getForDoctor);
router.post("/access-requests/:id/cancel", ...guard, validate(schema.idParam, "params"), controller.cancel);
// The ONLY way a doctor reaches a consented document: streamed, no-store, audited.
router.get(
  "/access-requests/:id/records/:recordId/file",
  ...guard,
  pdfLimiter,
  validate(schema.recordFileParams, "params"),
  controller.recordFile
);

module.exports = router;
