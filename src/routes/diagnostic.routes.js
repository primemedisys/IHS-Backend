/**
 * Diagnostic Lab routes (migration 038), mounted at /api/diagnostics.
 *
 * Authorization is by ROLE here and by OWNERSHIP in the service: patients only
 * reach their own requests, a lab only the requests shared with it. The lab
 * role is absent from every medicine route and the pharmacy roles from every
 * route below, so the two provider families never see each other's requests.
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const upload = require("../middlewares/upload");
const { ROLES } = require("../config/constants");
const controller = require("../controllers/diagnostic.controller");
const schema = require("../validators/diagnostic.validator");

const patient = [authenticate, authorize(ROLES.PATIENT)];
const lab = [authenticate, authorize(ROLES.DIAGNOSTIC_LAB)];
const participant = [authenticate, authorize(ROLES.PATIENT, ROLES.DIAGNOSTIC_LAB)];

// ── Patient ──────────────────────────────────────────────────────────────
router.get("/labs", ...patient, validateQuery(schema.listLabs), controller.listLabs);
router.post(
  "/requests",
  ...patient,
  upload.single("prescription"),
  validate(schema.shareRequest),
  controller.shareRequest
);
router.get("/requests/mine", ...patient, validateQuery(schema.listRequests), controller.listMyRequests);
router.post("/requests/:id/book", ...patient, validate(schema.book), controller.book);

// ── Lab ──────────────────────────────────────────────────────────────────
router.get("/requests/incoming", ...lab, validateQuery(schema.listRequests), controller.listLabRequests);
router.get("/summary", ...lab, controller.labSummary);
router.put("/requests/:id/status", ...lab, validate(schema.updateStatus), controller.updateStatus);
router.put("/requests/:id/response", ...lab, validate(schema.respond), controller.respond);
router.post(
  "/requests/:id/reports",
  ...lab,
  upload.single("report"),
  validate(schema.uploadReport),
  controller.uploadReport
);

// Lab catalogue.
router.get("/tests", ...lab, validateQuery(schema.listTests), controller.listTests);
router.post("/tests", ...lab, validate(schema.createTest), controller.createTest);
router.put("/tests/:id", ...lab, validate(schema.updateTest), controller.updateTest);
router.delete("/tests/:id", ...lab, controller.removeTest);

// ── Shared (the request's patient or its lab) ────────────────────────────
// Files are streamed through the API so they are never publicly addressable.
router.get("/requests/:id/file", ...participant, controller.streamFile);
router.get("/requests/:id/tests/:testId/report", ...participant, controller.streamReport);
router.get("/requests/:id", ...participant, controller.getRequest);

module.exports = router;
