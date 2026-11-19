/**
 * Public (no-auth) doctor reads: the portfolio page + the lookup lists that feed
 * the specialty/language pickers and discovery filters. Mounted at the API root
 * so paths are `/doctors/:slug`, `/specializations`, `/languages`.
 */
const router = require("express").Router();

const publicDoctor = require("../controllers/publicDoctor.controller");
const session = require("../controllers/session.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const schema = require("../validators/publicDoctor.validator");

router.get("/specializations", publicDoctor.listSpecializations);
router.get("/sub-specializations", publicDoctor.listSubSpecializations);
router.get("/languages", publicDoctor.listLanguages);
router.get("/insurances", publicDoctor.listInsurances);
// Discovery list (exact path — no param, so it never shadows /doctors/:slug).
router.get("/doctors", validateQuery(schema.listDoctors), publicDoctor.listDoctors);
// Map markers (literal segment — declared before `/doctors/:slug` so it's never
// captured as a slug).
router.get("/doctors/map", publicDoctor.listMapDoctors);
// Two-segment paths — declared before `/doctors/:slug` (a single-segment match).
// Which DAYS the doctor is consulting, and how full each one is
// (docs/consultation-queue). Replaced /doctors/:id/slots: the patient picks a
// clinic and a day, never a time.
router.get("/doctors/:id/sessions", session.publicSessions);
// Which payment choices the booking screen may offer (cash / the doctor's own
// UPI QR / the online gateway). Two segments with a literal tail, so it can't
// collide with `/doctors/:slug` or `/doctors/:slug/related`.
router.get("/doctors/:id/payment-options", validate(schema.doctorIdParam, "params"), publicDoctor.paymentOptions);
router.get("/doctors/:slug/related", publicDoctor.related);
router.get("/doctors/:slug", publicDoctor.getBySlug);

module.exports = router;
