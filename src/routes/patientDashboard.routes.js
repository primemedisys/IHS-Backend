/**
 * /patient dashboard routes (docs/dashboards-earnings). Mounted under `/patient`
 * alongside patient.routes.js.
 *
 * One endpoint, and it exists to move counting OFF the client: the patient app
 * used to fetch the entire booking list and reduce it with `.filter()`, which
 * silently under-reports the day `GET /patient/bookings` grows a `?page=`.
 *
 * Scoped to `req.user.id` — a patient has no id parameter to tamper with.
 */
const router = require("express").Router();

const dashboard = require("../controllers/dashboard.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];

router.get("/dashboard/summary", ...guard, dashboard.patientSummary);

module.exports = router;
