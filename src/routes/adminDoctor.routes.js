/**
 * /admin doctor-verification routes. Every route is guarded `authenticate` +
 * `authorize('admin')`. The admin UI lives in `frontend-admin`; these endpoints
 * are the contract it codes against.
 */
const router = require("express").Router();

const adminDoctor = require("../controllers/adminDoctor.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/doctor.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/doctors", ...guard, adminDoctor.listForReview);
router.get("/doctors/:id", ...guard, adminDoctor.getForReview);
router.post("/doctors/:id/verify", ...guard, validate(schema.verifyDoctor), adminDoctor.verify);
router.patch("/doctors/:id/listing", ...guard, validate(schema.setListing), adminDoctor.setListing);

module.exports = router;
