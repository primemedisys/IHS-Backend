/**
 * /doctor dashboard + earnings routes (docs/dashboards-earnings). Mounted under
 * `/doctor` alongside doctorBooking.routes.js.
 *
 * The guard chain IS the authorization: `resolveDoctorId('self')` pins
 * `req.doctorId` to the authenticated user, so there is no code path by which a
 * doctor aggregates another doctor's payments. Combined with validateQuery's
 * `stripUnknown`, an appended `?doctorId=<someone-else>` is deleted, not honoured.
 *
 * Query validation uses `validateQuery`, never `validate(schema, "query")` —
 * Express 5's `req.query` has no setter.
 */
const router = require("express").Router();

const dashboard = require("../controllers/dashboard.controller");
const earnings = require("../controllers/earnings.controller");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const schema = require("../validators/dashboard.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router.get("/dashboard/summary", ...guard, dashboard.doctorSummary);
router.get("/dashboard/today", ...guard, dashboard.doctorToday);

router.get("/earnings/summary", ...guard, validateQuery(schema.summary), earnings.summary);
router.get("/earnings/series", ...guard, validateQuery(schema.series), earnings.series);
router.get(
  "/earnings/transactions",
  ...guard,
  validateQuery(schema.transactions),
  earnings.transactions
);

module.exports = router;
