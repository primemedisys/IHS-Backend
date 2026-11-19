/**
 * Prescription request routes — patient uploads & provider visibility, plus
 * the availability round-trip and ordering off a shared prescription.
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const upload = require("../middlewares/upload");
const { ROLES, ALL_MEDICINE_PROVIDER_ROLES } = require("../config/constants");
const prescriptionRequestController = require("../controllers/prescriptionRequest.controller");
const prescriptionRequestValidator = require("../validators/prescriptionRequest.validator");

/**
 * The FULL pharmacy role list, legacy MR included: a provider must keep
 * answering the prescriptions already shared with it. Which providers a
 * patient may share a NEW prescription with is narrowed in the service
 * (rolesFor), not here.
 */
const PROVIDER_ROLES = ALL_MEDICINE_PROVIDER_ROLES;

// ── Patient routes ───────────────────────────────────────────────────────

router.post(
  "/",
  authenticate,
  authorize(ROLES.PATIENT),
  upload.single("prescription"),
  validate(prescriptionRequestValidator.uploadAndShare),
  prescriptionRequestController.uploadAndShare
);

router.get(
  "/my-requests",
  authenticate,
  authorize(ROLES.PATIENT),
  validateQuery(prescriptionRequestValidator.listRequests),
  prescriptionRequestController.getMyRequests
);

// ── Provider routes (pharmacy) ───────────────────────────────────────────

router.get(
  "/provider-requests",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(prescriptionRequestValidator.listRequests),
  prescriptionRequestController.getProviderRequests
);

router.put(
  "/:id/status",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(prescriptionRequestValidator.updateStatus),
  prescriptionRequestController.updateStatus
);

// Provider submits their stock-availability answers for a prescription.
router.put(
  "/:id/availability",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(prescriptionRequestValidator.submitAvailability),
  prescriptionRequestController.submitAvailability
);

// ── Patient: take the provider's available medicines forward ─────────────

/** Into the existing cart, to check out alongside anything else. */
router.post(
  "/:id/cart",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(prescriptionRequestValidator.addPrescriptionToCart),
  prescriptionRequestController.addPrescriptionToCart
);

/** Or straight to checkout, through the same order-creation path. */
router.post(
  "/:id/order",
  authenticate,
  authorize(ROLES.PATIENT),
  validate(prescriptionRequestValidator.placeOrderFromPrescription),
  prescriptionRequestController.placeOrderFromPrescription
);

// ── Shared (patient or provider) ─────────────────────────────────────────

// Prescription files are streamed through the API (feature 10) so they are
// never publicly accessible by URL.
router.get(
  "/:id/file",
  authenticate,
  authorize(ROLES.PATIENT, ...PROVIDER_ROLES),
  prescriptionRequestController.streamFile
);

router.get(
  "/:id",
  authenticate,
  authorize(ROLES.PATIENT, ...PROVIDER_ROLES),
  prescriptionRequestController.getRequestById
);

module.exports = router;
