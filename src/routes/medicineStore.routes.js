const router = require("express").Router();
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const upload = require("../middlewares/upload");
const { ROLES, ALL_MEDICINE_PROVIDER_ROLES } = require("../config/constants");

/**
 * The FULL pharmacy role list, legacy MR included: an existing MR keeps full
 * control of its OWN inventory and categories. Only the patient-facing
 * discovery surfaces (browse / providers) exclude it, in the service.
 */
const PROVIDER_ROLES = ALL_MEDICINE_PROVIDER_ROLES;
const medicineStoreValidator = require("../validators/medicineStore.validator");
const medicineStoreController = require("../controllers/medicineStore.controller");

// ── Public marketplace routes (no auth) ──────────────────────────────────

router.get("/browse", validateQuery(medicineStoreValidator.browseMedicines), medicineStoreController.browseMedicines);
router.get("/suggest", validateQuery(medicineStoreValidator.suggestMedicines), medicineStoreController.suggestMedicines);
router.get("/categories", validateQuery(medicineStoreValidator.listCategories), medicineStoreController.listCategories);
router.get("/medicine/:id", medicineStoreController.getMedicineDetails);
router.get("/provider/:providerId", medicineStoreController.getProviderProfile);
router.get("/providers", validateQuery(medicineStoreValidator.listProviders), medicineStoreController.listProviders);

// ── Provider routes (MR or Medicine Store) ───────────────────────────────

router.get(
  "/my-medicines",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(medicineStoreValidator.listMyMedicines),
  medicineStoreController.listMyMedicines
);

router.get(
  "/my-medicines/:id",
  authenticate,
  authorize(...PROVIDER_ROLES),
  medicineStoreController.getOne
);

router.post(
  "/my-medicines",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(medicineStoreValidator.createMedicine),
  medicineStoreController.create
);

router.put(
  "/my-medicines/:id",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(medicineStoreValidator.updateMedicine),
  medicineStoreController.update
);

router.delete(
  "/my-medicines/:id",
  authenticate,
  authorize(...PROVIDER_ROLES),
  medicineStoreController.remove
);

// ── Global medicine master (search existing before adding) ───────────────

router.get(
  "/masters",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(medicineStoreValidator.searchMasters),
  medicineStoreController.searchMasters
);

// ── Medicine images + substitutes (global master, migration 037) ────────
// Pharmacies (and admins) curate a master's photos and substitute list. The
// service further requires the pharmacy to sell that medicine, and only the
// uploader / admin may delete an image. Public reads come through
// /medicine/:id and /browse.

const CURATOR_ROLES = [...PROVIDER_ROLES, ROLES.ADMIN];

router.get(
  "/masters/:id/media",
  authenticate,
  authorize(...CURATOR_ROLES),
  medicineStoreController.getMasterMedia
);

router.post(
  "/masters/:id/images",
  authenticate,
  authorize(...CURATOR_ROLES),
  upload.single("image"),
  medicineStoreController.addMasterImage
);

router.put(
  "/masters/:id/images/order",
  authenticate,
  authorize(...CURATOR_ROLES),
  validate(medicineStoreValidator.reorderImages),
  medicineStoreController.reorderMasterImages
);

router.delete(
  "/masters/:id/images/:imageId",
  authenticate,
  authorize(...CURATOR_ROLES),
  medicineStoreController.removeMasterImage
);

router.put(
  "/masters/:id/substitutes",
  authenticate,
  authorize(...CURATOR_ROLES),
  validate(medicineStoreValidator.setSubstitutes),
  medicineStoreController.setMasterSubstitutes
);

// ── Global categories ────────────────────────────────────────────────────
// Categories are shared by every provider. MR / Store can list, search and
// add (find-or-create) — never rename or delete. Delete is admin-only.

router.get(
  "/my-categories",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validateQuery(medicineStoreValidator.listCategories),
  medicineStoreController.listCategories
);

router.post(
  "/my-categories",
  authenticate,
  authorize(...PROVIDER_ROLES),
  validate(medicineStoreValidator.createCategory),
  medicineStoreController.createCategory
);

// ── Admin category management ────────────────────────────────────────────

router.post(
  "/categories",
  authenticate,
  authorize(ROLES.ADMIN),
  validate(medicineStoreValidator.createCategory),
  medicineStoreController.createCategory
);

router.delete(
  "/categories/:id",
  authenticate,
  authorize(ROLES.ADMIN),
  medicineStoreController.deleteCategory
);

module.exports = router;
