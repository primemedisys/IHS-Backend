/**
 * /admin/medicine — read-only pharmacy & medicine tracking for the admin
 * console: ecosystem counts, order/payment tracking, provider-wise inventory.
 * Admin-guarded like every other /admin router; no writes live here.
 */
const router = require("express").Router();

const controller = require("../controllers/adminMedicine.controller");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/adminMedicine.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/medicine/overview", ...guard, validateQuery(schema.overview), controller.overview);
router.get("/medicine/orders", ...guard, validateQuery(schema.orders), controller.orders);
router.get("/medicine/inventory", ...guard, validateQuery(schema.inventory), controller.inventory);
router.get("/medicine/pharmacies", ...guard, validateQuery(schema.pharmacies), controller.pharmacies);

module.exports = router;
