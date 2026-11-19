/**
 * Patient-side blood routes (migration 039), mounted at /api/blood.
 * Every route is patient-only; ownership (patient_id) is enforced again in the
 * services. A patient never sees another patient's request, a donor record or
 * any bank's internal registers.
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const upload = require("../middlewares/upload");
const { ROLES } = require("../config/constants");
const c = require("../controllers/bloodPatient.controller");
const v = require("../validators/bloodBank.validator");

const patient = [authenticate, authorize(ROLES.PATIENT)];

router.get("/reference", ...patient, c.reference);
router.get("/nearby", ...patient, validateQuery(v.nearby), c.nearby);
router.get("/banks/:id", ...patient, c.getBank);

router.post(
  "/requests",
  ...patient,
  upload.single("document", { required: false }),
  validate(v.createRequest),
  c.createRequest
);
router.get("/requests", ...patient, validateQuery(v.listMyRequests), c.listRequests);
router.get("/requests/:id", ...patient, c.getRequest);
router.get("/requests/:id/document", ...patient, c.requestDocument);
router.post("/requests/:id/cancel", ...patient, validate(v.cancelRequest), c.cancelRequest);

router.get("/history", ...patient, c.history);

router.get("/camps", ...patient, validateQuery(v.publicCamps), c.listCamps);
router.get("/camps/mine", ...patient, c.myCamps);
router.post("/camps/:id/register", ...patient, validate(v.campRegister), c.registerCamp);
router.post("/camps/:id/cancel", ...patient, c.cancelCamp);

module.exports = router;
