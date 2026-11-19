/**
 * /admin/ambulance-* — admin oversight of the Ambulance module (migration
 * 040): provider verification queue (approve / reject / suspend), per-ambulance
 * review and deactivation, booking monitoring (read-only) and statistics.
 * Admin-guarded like every other /admin router.
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { ROLES } = require("../config/constants");
const c = require("../controllers/adminAmbulance.controller");
const v = require("../validators/ambulance.validator");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/ambulances/summary", ...guard, c.summary);

router.get("/ambulance-providers", ...guard, validateQuery(v.adminListProviders), c.listProviders);
router.get("/ambulance-providers/:id", ...guard, c.getProvider);
router.post("/ambulance-providers/:id/verify", ...guard, validate(v.adminVerifyProvider), c.verifyProvider);
router.patch("/ambulance-providers/:id/active", ...guard, validate(v.adminSetActive), c.setProviderActive);

router.get("/ambulance-bookings", ...guard, validateQuery(v.adminListBookings), c.listBookings);
router.get("/ambulance-bookings/:id", ...guard, c.getBooking);

router.get("/ambulances", ...guard, validateQuery(v.adminListAmbulances), c.listAmbulances);
router.get("/ambulances/:id", ...guard, c.getAmbulance);
router.post("/ambulances/:id/verify", ...guard, validate(v.adminVerifyAmbulance), c.verifyAmbulance);
router.patch("/ambulances/:id/active", ...guard, validate(v.adminSetActive), c.setAmbulanceActive);

module.exports = router;
