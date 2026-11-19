/**
 * /admin clinic-verification routes, mirroring adminDoctor.routes. Every route
 * is guarded `authenticate` + `authorize('admin')`.
 */
const router = require("express").Router();

const adminClinic = require("../controllers/adminClinic.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/admin.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/clinics", ...guard, adminClinic.listForReview);
router.get("/clinics/:id", ...guard, adminClinic.getForReview);
router.post("/clinics/:id/verify", ...guard, validate(schema.verifyClinic), adminClinic.verify);
router.patch("/clinics/:id/active", ...guard, validate(schema.setClinicActive), adminClinic.setActive);

module.exports = router;
