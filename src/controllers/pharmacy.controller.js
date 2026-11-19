/**
 * Pharmacy management (migration 043) — thin handlers. Every handler passes
 * the SIGNED-IN pharmacy's id (`req.user.id`) to the service, which scopes
 * every query by it: a pharmacy can only ever read or change its own data.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const sendFile = require("../utils/sendFile");
const reportService = require("../services/pharmacyReport.service");
const inventoryService = require("../services/pharmacyInventory.service");
const importService = require("../services/pharmacyImport.service");
const supplierService = require("../services/pharmacySupplier.service");
const purchaseService = require("../services/pharmacyPurchase.service");
const returnService = require("../services/medicineReturn.service");
const settingsService = require("../services/pharmacySettings.service");
const orderGroupService = require("../services/medicineOrderGroup.service");

// ── Dashboard + reports ──────────────────────────────────────────────────────

exports.dashboard = asyncHandler(async (req, res) => ok(res, await reportService.dashboard(req.user.id)));
exports.dashboardAnalytics = asyncHandler(async (req, res) => ok(res, await reportService.analytics(req.user.id, req.validatedQuery)));
exports.salesReport = asyncHandler(async (req, res) => ok(res, await reportService.sales(req.user.id, req.validatedQuery)));
exports.topMedicines = asyncHandler(async (req, res) => ok(res, await reportService.topMedicines(req.user.id, req.validatedQuery)));
exports.purchaseReport = asyncHandler(async (req, res) => ok(res, await reportService.purchases(req.user.id, req.validatedQuery)));
exports.gstReport = asyncHandler(async (req, res) => ok(res, await reportService.gst(req.user.id, req.validatedQuery)));
exports.stockReport = asyncHandler(async (req, res) => ok(res, await reportService.stock(req.user.id)));

// ── Stock: batches, receipts, history ────────────────────────────────────────

exports.listBatches = asyncHandler(async (req, res) => ok(res, await inventoryService.listBatches(req.user.id, req.validatedQuery)));

exports.writeOffExpired = asyncHandler(async (req, res) => {
  const result = await inventoryService.writeOffExpired(req.user.id, req.body, req.user.id);
  return ok(res, result, result.units ? `${result.units} expired unit(s) written off` : "No expired stock to write off");
});

exports.receiveStock = asyncHandler(async (req, res) => {
  const medicine = await inventoryService.receiveStock(req.user.id, req.params.id, req.body, req.user.id);
  return ok(res, { medicine }, "Stock added");
});

exports.updateBatch = asyncHandler(async (req, res) => {
  const medicine = await inventoryService.updateBatch(req.user.id, req.params.id, req.params.batchId, req.body, req.user.id);
  return ok(res, { medicine }, "Batch updated");
});

exports.listMovements = asyncHandler(async (req, res) =>
  ok(res, await inventoryService.listMovements(req.user.id, req.params.id, req.validatedQuery))
);

// ── Excel import / export ────────────────────────────────────────────────────

exports.importTemplate = asyncHandler(async (req, res) => sendFile(res, await importService.template(req.user.id), { download: true }));
exports.exportInventory = asyncHandler(async (req, res) =>
  sendFile(res, await importService.exportInventory(req.user.id, req.validatedQuery), { download: true })
);
exports.importPreview = asyncHandler(async (req, res) => ok(res, await importService.preview(req.user.id, req.file, req.body)));

exports.importCommit = asyncHandler(async (req, res) => {
  const result = await importService.commit(req.user.id, req.user.role, req.file, req.body, req.user.id);
  return ok(res, result, `${result.summary.imported} row(s) imported`);
});

// ── Suppliers ────────────────────────────────────────────────────────────────

exports.listSuppliers = asyncHandler(async (req, res) => ok(res, await supplierService.list(req.user.id, req.validatedQuery)));
exports.getSupplier = asyncHandler(async (req, res) => ok(res, { supplier: await supplierService.get(req.user.id, req.params.id) }));
exports.createSupplier = asyncHandler(async (req, res) =>
  created(res, { supplier: await supplierService.create(req.user.id, req.body) }, "Supplier added")
);
exports.updateSupplier = asyncHandler(async (req, res) =>
  ok(res, { supplier: await supplierService.update(req.user.id, req.params.id, req.body) }, "Supplier updated")
);

// ── Purchases ────────────────────────────────────────────────────────────────

exports.listPurchases = asyncHandler(async (req, res) => ok(res, await purchaseService.list(req.user.id, req.validatedQuery)));
exports.getPurchase = asyncHandler(async (req, res) => ok(res, { purchase: await purchaseService.get(req.user.id, req.params.id) }));
exports.createPurchase = asyncHandler(async (req, res) =>
  created(res, { purchase: await purchaseService.create(req.user.id, req.user.role, req.body, req.user.id) }, "Purchase recorded — stock updated")
);
exports.cancelPurchase = asyncHandler(async (req, res) =>
  ok(res, { purchase: await purchaseService.cancel(req.user.id, req.params.id, req.user.id) }, "Purchase cancelled — stock reversed")
);

// ── Billing: returns / credit notes, payments ────────────────────────────────

exports.createReturn = asyncHandler(async (req, res) =>
  created(res, { return: await returnService.create(req.user.id, req.params.id, req.body, req.user.id) }, "Return recorded")
);
exports.listReturns = asyncHandler(async (req, res) => ok(res, await returnService.list(req.user.id, req.validatedQuery)));
exports.getReturn = asyncHandler(async (req, res) => ok(res, { return: await returnService.get(req.user.id, req.params.id) }));
exports.listPayments = asyncHandler(async (req, res) =>
  ok(res, await orderGroupService.getProviderPayments(req.user.id, req.validatedQuery))
);

// ── Settings ─────────────────────────────────────────────────────────────────

exports.getSettings = asyncHandler(async (req, res) => ok(res, await settingsService.getSettings(req.user.id)));
exports.updateSettings = asyncHandler(async (req, res) =>
  ok(res, await settingsService.updateSettings(req.user.id, req.body), "Settings saved")
);
