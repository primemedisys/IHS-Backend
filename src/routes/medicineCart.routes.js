/**
 * The medicine cart — patient-only. There is exactly one cart per patient and
 * it lives on the server, so "add to cart" is an authenticated action: a
 * signed-out visitor can browse and read every medicine, but the moment they
 * add one the frontend sends them through the existing login and back.
 */
const router = require("express").Router();
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const { ROLES } = require("../config/constants");
const cartValidator = require("../validators/medicineCart.validator");
const cartController = require("../controllers/medicineCart.controller");

// Every route below is the CALLER's own cart — `req.user.id` is the only cart
// key, so a patient can never read or change another patient's cart.
router.use(authenticate, authorize(ROLES.PATIENT));

router.get("/", cartController.getCart);
router.get("/count", cartController.getCount);
// COD / UPI QR availability for this cart's pharmacies (migration 044).
router.get("/payment-options", cartController.getPaymentOptions);
router.post("/items", validate(cartValidator.addItem), cartController.addItem);
router.put("/items/:id", validate(cartValidator.updateItem), cartController.updateItem);
router.delete("/items/:id", cartController.removeItem);
router.delete("/", cartController.clear);

module.exports = router;
