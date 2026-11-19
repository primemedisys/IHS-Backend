/**
 * /admin/blood-banks — admin oversight of the Blood Bank module (migration
 * 039): verification queue (approve / reject), suspension, and read-only
 * aggregate tracking. Admin-guarded like every other /admin router.
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { ROLES } = require("../config/constants");
const c = require("../controllers/adminBloodBank.controller");
const v = require("../validators/bloodBank.validator");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/blood-banks/summary", ...guard, c.summary);
router.get("/blood-banks/inventory", ...guard, validateQuery(v.adminInventory), c.inventory);
router.get("/blood-banks/requests", ...guard, validateQuery(v.adminListRequests), c.requests);
router.get("/blood-banks", ...guard, validateQuery(v.adminListBanks), c.listBanks);
router.get("/blood-banks/:id", ...guard, c.getBank);
router.post("/blood-banks/:id/verify", ...guard, validate(v.adminVerify), c.verify);
router.patch("/blood-banks/:id/active", ...guard, validate(v.adminSetActive), c.setActive);

module.exports = router;
