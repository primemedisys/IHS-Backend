const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const medicineStoreService = require("../services/medicineStore.service");
const medicineMediaService = require("../services/medicineMedia.service");

// ── Provider (MR / Store) ────────────────────────────────────────────────

exports.listMyMedicines = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.listMyMedicines(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.getOne = asyncHandler(async (req, res) => {
  const medicine = await medicineStoreService.getOne(req.user.id, req.params.id);
  return ok(res, { medicine });
});

exports.create = asyncHandler(async (req, res) => {
  const medicine = await medicineStoreService.create(req.user.id, req.user.role, req.body);
  return created(res, { medicine }, "Medicine created");
});

exports.update = asyncHandler(async (req, res) => {
  const medicine = await medicineStoreService.update(req.user.id, req.params.id, req.body);
  return ok(res, { medicine });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.remove(req.user.id, req.params.id);
  return ok(res, result);
});

exports.searchMasters = asyncHandler(async (req, res) => {
  const masters = await medicineStoreService.searchMasters(req.user.id, req.validatedQuery);
  return ok(res, { masters });
});

// ── Medicine images + substitutes (global master) ───────────────────────

exports.getMasterMedia = asyncHandler(async (req, res) => {
  const media = await medicineMediaService.getMasterMedia(req.user, req.params.id);
  return ok(res, media);
});

exports.addMasterImage = asyncHandler(async (req, res) => {
  const media = await medicineMediaService.addImage(req.user, req.params.id, req.file);
  return created(res, media, "Image uploaded");
});

exports.removeMasterImage = asyncHandler(async (req, res) => {
  const media = await medicineMediaService.removeImage(req.user, req.params.id, req.params.imageId);
  return ok(res, media, "Image removed");
});

exports.reorderMasterImages = asyncHandler(async (req, res) => {
  const media = await medicineMediaService.reorderImages(req.user, req.params.id, req.body.imageIds);
  return ok(res, media);
});

exports.setMasterSubstitutes = asyncHandler(async (req, res) => {
  const media = await medicineMediaService.setSubstitutes(req.user, req.params.id, req.body.substituteIds);
  return ok(res, media, "Substitutes updated");
});

// ── Patient / Public marketplace ─────────────────────────────────────────

exports.browseMedicines = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.browseMedicines(req.validatedQuery);
  return ok(res, result);
});

exports.suggestMedicines = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.suggestMedicines(req.validatedQuery);
  return ok(res, result);
});

exports.getMedicineDetails = asyncHandler(async (req, res) => {
  const medicine = await medicineStoreService.getMedicineDetails(req.params.id);
  return ok(res, { medicine });
});

exports.getProviderProfile = asyncHandler(async (req, res) => {
  const profile = await medicineStoreService.getProviderProfile(req.params.providerId);
  return ok(res, { profile });
});

exports.listProviders = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.listProviders(req.validatedQuery);
  return ok(res, result);
});

// ── Categories ───────────────────────────────────────────────────────────

exports.listCategories = asyncHandler(async (req, res) => {
  const categories = await medicineStoreService.listCategories(req.validatedQuery);
  return ok(res, { categories });
});

// Find-or-create: 201 when a new global category was created, 200 when an
// equivalent (case-insensitive) one already existed and is returned instead.
exports.createCategory = asyncHandler(async (req, res) => {
  const { category, created: isNew } = await medicineStoreService.createCategory(req.user.id, req.user.role, req.body);
  if (isNew) return created(res, { category, created: true }, "Category created");
  return ok(res, { category, created: false }, "Category already exists — using the existing one");
});

exports.deleteCategory = asyncHandler(async (req, res) => {
  const result = await medicineStoreService.deleteCategory(req.params.id);
  return ok(res, result);
});
