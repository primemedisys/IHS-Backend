/**
 * The patient's own "My Medicines" — routines, doses, reminder settings
 * (migration 055). Mounted under /patient. Patient role only; every call is
 * keyed on the signed-in patient (req.user.id), never on an id in the request.
 *
 * Static paths (/search, /summary, /doses, /settings) are declared before
 * /:id so they are never read as an id.
 */
const router = require("express").Router();
const c = require("../controllers/patientMedicine.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const s = require("../validators/patientMedicine.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.PATIENT)];

router.get("/medicines", ...guard, validateQuery(s.listQuery), c.list);
router.post("/medicines", ...guard, validate(s.createMedicines), c.create);
router.get("/medicines/search", ...guard, validateQuery(s.searchQuery), c.search);
router.get("/medicines/summary", ...guard, c.summary);
router.get("/medicines/doses", ...guard, validateQuery(s.dosesQuery), c.doses);
router.get("/medicines/doses/history", ...guard, validateQuery(s.historyQuery), c.history);
router.post(
  "/medicines/doses/:doseId/action",
  ...guard,
  validate(s.doseParams, "params"),
  validate(s.doseAction),
  c.doseAction
);
router.get("/medicines/settings", ...guard, c.getSettings);
router.put("/medicines/settings", ...guard, validate(s.updateSettings), c.updateSettings);
router.get("/medicines/:id", ...guard, validate(s.idParams, "params"), c.getOne);
router.patch("/medicines/:id", ...guard, validate(s.idParams, "params"), validate(s.updateMedicine), c.update);
router.put("/medicines/:id/status", ...guard, validate(s.idParams, "params"), validate(s.setStatus), c.setStatus);

module.exports = router;
