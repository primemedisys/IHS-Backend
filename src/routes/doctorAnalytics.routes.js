/**
 * /doctor/analytics — Doctor Dashboard 2.0 (docs/doctor-dashboard-2-31-10-2026).
 * Mounted under `/doctor`. The guard chain IS the authorization:
 * `resolveDoctorId('self')` pins req.doctorId to the signed-in doctor and
 * validateQuery strips any other id, so a doctor can only ever aggregate their
 * own bookings and payments. Platform-wide figures are never served here.
 */
const router = require("express").Router();
const c = require("../controllers/doctorAnalytics.controller");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const s = require("../validators/doctorAnalytics.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router.get("/analytics/overview", ...guard, validateQuery(s.rangeQuery), c.overview);
router.get("/analytics/trends", ...guard, validateQuery(s.rangeQuery), c.trends);
router.get("/analytics/patients", ...guard, validateQuery(s.patientsQuery), c.patients);
router.get("/analytics/appointments", ...guard, validateQuery(s.appointmentsQuery), c.appointments);
router.get("/analytics/financial", ...guard, validateQuery(s.financialQuery), c.financial);
router.get("/analytics/quality", ...guard, validateQuery(s.rangeQuery), c.quality);
router.get("/analytics/productivity", ...guard, validateQuery(s.rangeQuery), c.productivity);
router.get("/analytics/acquisition", ...guard, validateQuery(s.rangeQuery), c.acquisition);

module.exports = router;
