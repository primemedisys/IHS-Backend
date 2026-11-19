/**
 * "How did you hear about Dr. X?" — the patient side (migration 056). Mounted
 * under /patient. The answer itself is sent with POST /patient/bookings
 * (`acquisition`), so it is saved atomically with the booking.
 */
const router = require("express").Router();
const Joi = require("joi");
const c = require("../controllers/acquisition.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];
const doctorParams = Joi.object({ doctorId: Joi.string().pattern(/^\d{1,20}$/).required() });

// The option list the booking forms render (server-owned, so it can grow without an app release).
router.get("/acquisition/sources", ...guard, c.sources);
// Has this patient already told us how they found this doctor? (Then the form skips the question.)
router.get("/acquisition/doctors/:doctorId", ...guard, validate(doctorParams, "params"), c.statusForDoctor);

module.exports = router;
