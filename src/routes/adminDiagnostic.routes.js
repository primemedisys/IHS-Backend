/**
 * /admin/diagnostics — read-only Diagnostic Lab tracking for the admin console
 * (migration 038): lab counts and the patient → lab → booking → report
 * workflow. Admin-guarded like every other /admin router; no writes live here.
 */
const router = require("express").Router();

const controller = require("../controllers/adminDiagnostic.controller");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/diagnostic.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/diagnostics/overview", ...guard, controller.overview);
router.get("/diagnostics/requests", ...guard, validateQuery(schema.adminListRequests), controller.requests);

module.exports = router;
