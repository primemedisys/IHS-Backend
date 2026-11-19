/**
 * Doctor EMR workspace (migration 051), mounted under /doctor → /api/doctor/emr/*.
 *
 * READ routes are patient-keyed and gated in the service on a real
 * doctor–patient relationship (a confirmed/completed booking). WRITE routes go
 * through a booking the doctor owns (the visit the record belongs to).
 */
const router = require("express").Router();
const emr = require("../controllers/emr.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const s = require("../validators/emr.validator");
const consent = require("../validators/recordAccess.validator");
const { accessRequestLimiter } = require("../middlewares/rateLimiters");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router.get("/emr/catalog", ...guard, emr.catalog);
router.get("/emr/workbench", ...guard, validateQuery(s.workbenchQuery), emr.workbench);

router.get("/emr/search/medicines", ...guard, validateQuery(s.searchQuery), emr.searchMedicines);
router.get("/emr/search/investigations", ...guard, validateQuery(s.searchQuery), emr.searchInvestigations);
router.get("/emr/search/diagnoses", ...guard, validateQuery(s.searchQuery), emr.diagnosisSuggestions);
// Migration 059 — the admin ICD catalogue, by diagnosis name or code.
router.get("/emr/search/icd", ...guard, validateQuery(s.searchQuery), emr.searchIcd);

router.get(
  "/emr/patients/:patientId",
  ...guard,
  validate(s.patientParams, "params"),
  validateQuery(s.workspaceQuery),
  emr.patient
);
router.get(
  "/emr/patients/:patientId/vitals",
  ...guard,
  validate(s.patientParams, "params"),
  validateQuery(s.vitalsQuery),
  emr.vitals
);
router.get(
  "/emr/patients/:patientId/entries",
  ...guard,
  validate(s.patientParams, "params"),
  validateQuery(s.entriesQuery),
  emr.entries
);
router.get(
  "/emr/patients/:patientId/visits/:bookingId",
  ...guard,
  validate(s.visitParams, "params"),
  emr.visitSummary
);

// Structured history + per-category consent (migration 057). Every read is
// limited to the doctor's own records + the categories the patient granted.
router.get("/emr/patients/:patientId/history", ...guard, validate(s.patientParams, "params"), emr.history);
router.get("/emr/patients/:patientId/timeline", ...guard, validate(s.patientParams, "params"), validateQuery(s.timelineQuery), emr.timeline);
router.get("/emr/patients/:patientId/audit", ...guard, validate(s.patientParams, "params"), validateQuery(s.auditQuery), emr.audit);
router.get("/emr/patients/:patientId/access", ...guard, validate(s.patientParams, "params"), emr.access);
// The patient's documents behind the same consent gate (own / granted category / shared document).
router.get("/emr/patients/:patientId/documents", ...guard, validate(s.patientParams, "params"), emr.documents);
router.post(
  "/emr/patients/:patientId/access-requests",
  ...guard,
  accessRequestLimiter,
  validate(s.patientParams, "params"),
  validate(consent.createClinicalAccessRequest),
  emr.requestAccess
);

router.post(
  "/emr/bookings/:bookingId/vitals",
  ...guard,
  validate(s.bookingParams, "params"),
  validate(s.addVitals),
  emr.addVitals
);
router.post(
  "/emr/bookings/:bookingId/entries",
  ...guard,
  validate(s.bookingParams, "params"),
  validate(s.createEntry),
  emr.createEntry
);

router.patch("/emr/entries/:id", ...guard, validate(s.idParams, "params"), validate(s.updateEntry), emr.updateEntry);
router.post(
  "/emr/entries/:id/retire",
  ...guard,
  validate(s.idParams, "params"),
  validate(s.retireEntry),
  emr.retireEntry
);

module.exports = router;
