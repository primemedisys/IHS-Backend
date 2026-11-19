const router = require("express").Router();
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const { ROLES, ALL_MEDICINE_PROVIDER_ROLES } = require("../config/constants");
const medicineOrderValidator = require("../validators/medicineOrder.validator");
const pharmacyValidator = require("../validators/pharmacy.validator");
const paymentQrValidator = require("../validators/paymentQr.validator");
const medicineOrderController = require("../controllers/medicineOrder.controller");

/**
 * Pharmacy roles allowed on the provider routes. This is the FULL list, legacy
 * MR included: an MR must keep managing the orders it already has. Only the
 * patient-facing discovery/ordering surfaces exclude MR.
 */
const PROVIDER_ROLES = ALL_MEDICINE_PROVIDER_ROLES;

// ── Patient: checkout, orders and the bill ───────────────────────────────

/** Check out the cart (or the selected lines) into one order per pharmacy. */
router.post(
  "/checkout",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(medicineOrderValidator.checkout),
  medicineOrderController.checkout
);

/** Order one medicine directly, without the cart. */
router.post(
  "/",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(medicineOrderValidator.placeOrder),
  medicineOrderController.placeOrder
);

/** The patient's orders, one row per order (not per medicine). */
router.get(
  "/groups/my",
  authenticate,
  authorize(ROLES.PATIENT),
  validateQuery(medicineOrderValidator.listOrders),
  medicineOrderController.getMyOrderGroups
);

/** The pharmacy's incoming orders — searchable by order no. / patient, date, payment, medicine. */
router.get(
  "/groups/provider",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(pharmacyValidator.listProviderOrders),
  medicineOrderController.getProviderOrderGroups
);

/**
 * Settle an online order's SIMULATED payment. This is the seam a real gateway
 * callback replaces — nothing here contacts a gateway or moves money.
 */
router.post(
  "/groups/:id/pay",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(medicineOrderValidator.payOrder),
  medicineOrderController.payOrder
);

router.put(
  "/groups/:id/cancel",
  authenticate,
  authorize(ROLES.PATIENT),
  medicineOrderController.cancelOrderGroup
);

/** The pharmacy moves the order along its delivery lifecycle. */
router.put(
  "/groups/:id/status",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(medicineOrderValidator.updateStatus),
  medicineOrderController.updateOrderGroupStatus
);

// ── UPI QR: paid straight to the pharmacy's own QR (migration 044) ───────

/** Patient: the pharmacy's QR + amount + reference for one of their own upi_qr orders. */
router.get(
  "/groups/:id/payment-qr",
  authenticate,
  authorize(ROLES.PATIENT),
  medicineOrderController.getPaymentQr
);

/** Patient: "I have paid" (optional UPI reference). Recorded + the pharmacy told; no status changes. */
router.post(
  "/groups/:id/payment-report",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(paymentQrValidator.reportPayment),
  medicineOrderController.reportPayment
);

/** Pharmacy: the money reached its UPI app → the bill is paid. The only way a UPI QR order is settled. */
router.post(
  "/groups/:id/payment/confirm-received",
  authenticate,
  authorize(...PROVIDER_ROLES),
  medicineOrderController.confirmPaymentReceived
);

/** The bill — derived from the order, readable by its patient or its pharmacy. */
router.get(
  "/groups/:id/invoice",
  authenticate,
  authorize(ROLES.PATIENT, ...PROVIDER_ROLES),
  medicineOrderController.getInvoice
);

router.get(
  "/groups/:id",
  authenticate,
  authorize(ROLES.PATIENT, ...PROVIDER_ROLES),
  medicineOrderController.getOrderGroupById
);

// ── Per-medicine order lines (the pre-036 surface, unchanged) ────────────

router.get(
  "/my-orders",
  authenticate,
  authorize(ROLES.PATIENT),
  validateQuery(medicineOrderValidator.listOrders),
  medicineOrderController.getMyOrders
);

router.put(
  "/:id/cancel",
  authenticate,
  authorize(ROLES.PATIENT),
  medicineOrderController.cancelOrder
);

router.get(
  "/provider-orders",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(medicineOrderValidator.listOrders),
  medicineOrderController.getProviderOrders
);

router.put(
  "/:id/status",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(medicineOrderValidator.updateStatus),
  medicineOrderController.updateOrderStatus
);

router.get(
  "/:id",
  authenticate,
  authorize(ROLES.PATIENT, ...PROVIDER_ROLES),
  medicineOrderController.getOrderById
);

module.exports = router;
