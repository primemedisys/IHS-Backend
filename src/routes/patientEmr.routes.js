/**
 * The patient's own medical profile (migration 051), mounted under /patient.
 * Always keyed on the signed-in patient (req.user.id) — a patient id is never
 * read from the request.
 */
const router = require("express").Router();
const emr = require("../controllers/emr.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const s = require("../validators/emr.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];

router.get("/medical-profile", ...guard, emr.myMedicalProfile);
// The structured history (consultations with their prescriptions, diagnoses…).
router.get("/medical-history", ...guard, emr.myMedicalHistory);
router.get("/visits/:bookingId/summary", ...guard, validate(s.bookingParams, "params"), emr.myVisitSummary);

module.exports = router;
