/**
 * Ambulance provider portal routes (migration 040), mounted at /api/ambulance.
 *
 *   authenticate → authorize(ambulance_provider) → [requireApprovedAmbulanceProvider] → validate → controller
 *
 * Only the profile + reference routes are open to a PENDING provider (so it
 * can finish / correct its details); everything operational requires admin
 * approval. Ownership is enforced again in every service (provider_id scoping).
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const requireApproved = require("../middlewares/requireApprovedAmbulanceProvider");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { ROLES } = require("../config/constants");
const c = require("../controllers/ambulanceProvider.controller");
const v = require("../validators/ambulance.validator");

const signedIn = [authenticate, authorize(ROLES.AMBULANCE_PROVIDER)];
const provider = [...signedIn, requireApproved];

// ── Profile / reference (pending providers too) ──────────────────────────
router.get("/profile", ...signedIn, c.getProfile);
router.put("/profile", ...signedIn, validate(v.updateProfile), c.updateProfile);
router.post("/profile/resubmit", ...signedIn, c.resubmit);
router.get("/reference", ...signedIn, c.reference);

// ── Dashboard ────────────────────────────────────────────────────────────
router.get("/dashboard", ...provider, c.dashboard);

// ── Ambulances ───────────────────────────────────────────────────────────
router.get("/ambulances", ...provider, validateQuery(v.listAmbulances), c.listAmbulances);
router.post("/ambulances", ...provider, validate(v.createAmbulance), c.createAmbulance);
router.get("/ambulances/:id", ...provider, c.getAmbulance);
router.put("/ambulances/:id", ...provider, validate(v.updateAmbulance), c.updateAmbulance);
router.put("/ambulances/:id/availability", ...provider, validate(v.setAvailability), c.setAvailability);
router.put("/ambulances/:id/driver", ...provider, validate(v.setDefaultDriver), c.setDefaultDriver);

// ── Drivers ──────────────────────────────────────────────────────────────
router.get("/drivers", ...provider, validateQuery(v.listDrivers), c.listDrivers);
router.post("/drivers", ...provider, validate(v.createDriver), c.createDriver);
router.get("/drivers/:id", ...provider, c.getDriver);
router.put("/drivers/:id", ...provider, validate(v.updateDriver), c.updateDriver);

// ── Bookings ─────────────────────────────────────────────────────────────
router.get("/bookings", ...provider, validateQuery(v.listBookings), c.listBookings);
router.get("/bookings/:id", ...provider, c.getBooking);
router.post("/bookings/:id/accept", ...provider, validate(v.acceptBooking), c.accept);
router.post("/bookings/:id/reject", ...provider, validate(v.rejectBooking), c.reject);
router.post("/bookings/:id/assign-driver", ...provider, validate(v.assignDriver), c.assignDriver);
router.post("/bookings/:id/status", ...provider, validate(v.progressBooking), c.progress);
router.post("/bookings/:id/complete", ...provider, validate(v.completeBooking), c.complete);
router.post("/bookings/:id/cancel", ...provider, validate(v.providerCancel), c.cancel);

module.exports = router;
