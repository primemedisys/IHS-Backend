/**
 * Public ambulance discovery + patient bookings (migration 040), mounted at
 * /api/ambulances.
 *
 * Discovery (reference / nearby / one ambulance / estimate) is PUBLIC — anyone
 * can find an ambulance without an account, and only approved, active
 * ambulances of approved, active providers are ever returned. Booking needs a
 * patient login; ownership (patient_id) is enforced again in the service.
 *
 * Order matters: the literal paths are declared before "/:id".
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { ROLES } = require("../config/constants");
const c = require("../controllers/ambulancePublic.controller");
const v = require("../validators/ambulance.validator");

const patient = [authenticate, authorize(ROLES.PATIENT)];

// ── Public discovery ─────────────────────────────────────────────────────
router.get("/reference", c.reference);
router.get("/nearby", validateQuery(v.nearby), c.nearby);

// ── Patient bookings ─────────────────────────────────────────────────────
router.post("/bookings", ...patient, validate(v.createBooking), c.createBooking);
router.get("/bookings", ...patient, validateQuery(v.listBookings), c.listBookings);
router.get("/bookings/:id", ...patient, c.getBooking);
router.post("/bookings/:id/cancel", ...patient, validate(v.patientCancel), c.cancelBooking);

// ── One ambulance (public) ───────────────────────────────────────────────
router.get("/:id", validateQuery(v.publicDetails), c.getAmbulance);
router.get("/:id/estimate", validateQuery(v.estimate), c.estimate);

module.exports = router;
