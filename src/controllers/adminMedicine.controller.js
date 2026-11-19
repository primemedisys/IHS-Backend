/**
 * Admin pharmacy / medicine tracking reads. THIN: validated query → one
 * service call → envelope. The service already returns plain objects (raw SQL
 * aggregates, only the public fields), so there is no model to serialize.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const adminMedicineService = require("../services/adminMedicine.service");

exports.overview = asyncHandler(async (req, res) =>
  ok(res, await adminMedicineService.overview(req.validatedQuery), "Medicine & pharmacy overview"));

exports.orders = asyncHandler(async (req, res) =>
  ok(res, await adminMedicineService.listOrders(req.validatedQuery), "Medicine orders"));

exports.inventory = asyncHandler(async (req, res) =>
  ok(res, await adminMedicineService.listInventory(req.validatedQuery), "Medicine inventory"));

exports.pharmacies = asyncHandler(async (req, res) =>
  ok(res, await adminMedicineService.listPharmacies(req.validatedQuery), "Pharmacies"));
