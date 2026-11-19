/**
 * /patient — the patient's side of doctor record-access consent (migration 045).
 * Every query is scoped to req.user.id, so a patient can only see and decide
 * requests addressed to them; another patient or any doctor gets a 404/403.
 */
const router = require("express").Router();
const controller = require("../controllers/recordAccess.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const schema = require("../validators/recordAccess.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];

router.get("/access-requests", ...guard, validateQuery(schema.listQuery), controller.listForPatient);
router.get("/access-requests/:id", ...guard, validate(schema.idParam, "params"), controller.getForPatient);
router.post(
  "/access-requests/:id/approve",
  ...guard,
  validate(schema.idParam, "params"),
  validate(schema.approveAccessRequest),
  controller.approve
);
router.post(
  "/access-requests/:id/reject",
  ...guard,
  validate(schema.idParam, "params"),
  validate(schema.rejectAccessRequest),
  controller.reject
);
router.post("/access-requests/:id/revoke", ...guard, validate(schema.idParam, "params"), controller.revoke);

module.exports = router;
