/**
 * /admin dashboard routes (docs/dashboards-earnings). Platform-wide money and
 * operational health. Admin-guarded and deliberately unscoped — seeing every
 * doctor's numbers is the point.
 *
 * `platformRevenue` is COMMISSION, not GMV. The summary ships both, adjacent, so
 * the invariant `platformRevenue + doctorPayouts === gmv` is visible on the page
 * and a broken aggregate is obvious without opening a console.
 */
const router = require("express").Router();

const dashboard = require("../controllers/dashboard.controller");
const earnings = require("../controllers/earnings.controller");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/dashboard.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/dashboard/summary", ...guard, validateQuery(schema.summary), dashboard.adminSummary);
router.get("/dashboard/revenue-series", ...guard, validateQuery(schema.series), earnings.revenueSeries);
router.get("/dashboard/top-doctors", ...guard, validateQuery(schema.topDoctors), earnings.topDoctors);
router.get("/bookings", ...guard, dashboard.adminBookings);

module.exports = router;
