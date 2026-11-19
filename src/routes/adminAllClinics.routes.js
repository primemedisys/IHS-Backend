/**
 * /admin all-clinics route — every registered clinic account on the platform,
 * newest registered first. Distinct from adminClinic.routes.js which is the
 * verification queue filtered by status.
 */
const router = require("express").Router();

const allClinics = require("../controllers/adminAllClinics.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/all-clinics", ...guard, allClinics.listAll);

module.exports = router;
