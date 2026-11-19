/**
 * Pharmacy management (migration 043), mounted at /medicine/pharmacy.
 *
 * Every route: authenticate → a pharmacy role (the FULL list, legacy MR
 * included, like the existing inventory routes) → validation → controller.
 * The services scope every query by the signed-in pharmacy, so these routes
 * can never reach another pharmacy's inventory, purchases, suppliers, orders
 * or reports. Patients, doctors, labs and admins get 403 here.
 *
 * Inventory CRUD itself stays on the existing /medicine/my-medicines routes
 * and the order list on /medicine/orders/groups/provider — nothing is
 * duplicated here.
 */
const router = require("express").Router();
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const upload = require("../middlewares/upload");
const { ALL_MEDICINE_PROVIDER_ROLES } = require("../config/constants");
const v = require("../validators/pharmacy.validator");
const c = require("../controllers/pharmacy.controller");
const paymentQr = require("../controllers/paymentQr.controller");
const paymentQrSchema = require("../validators/paymentQr.validator");

router.use(authenticate, authorize(...ALL_MEDICINE_PROVIDER_ROLES));

// ── Dashboard + reports ──────────────────────────────────────────────────────
router.get("/dashboard", c.dashboard);
router.get("/dashboard/analytics", validateQuery(v.reportRange), c.dashboardAnalytics);
router.get("/reports/sales", validateQuery(v.reportRange), c.salesReport);
router.get("/reports/top-medicines", validateQuery(v.reportRange), c.topMedicines);
router.get("/reports/purchases", validateQuery(v.reportRange), c.purchaseReport);
router.get("/reports/gst", validateQuery(v.reportRange), c.gstReport);
router.get("/reports/stock", c.stockReport);

// ── Stock: batches, receipts, corrections, history ───────────────────────────
router.get("/batches", validateQuery(v.listBatches), c.listBatches);
router.post("/batches/write-off-expired", validate(v.writeOffExpired), c.writeOffExpired);
router.post("/inventory/:id/stock", validate(v.receiveStock), c.receiveStock);
router.put("/inventory/:id/batches/:batchId", validate(v.updateBatch), c.updateBatch);
router.get("/inventory/:id/movements", validateQuery(v.listMovements), c.listMovements);

// ── Excel import / export ────────────────────────────────────────────────────
router.get("/import/template", c.importTemplate);
router.post("/import/preview", upload.single("file"), validate(v.importOptions), c.importPreview);
router.post("/import", upload.single("file"), validate(v.importOptions), c.importCommit);
router.get("/export", validateQuery(v.exportInventory), c.exportInventory);

// ── Suppliers ────────────────────────────────────────────────────────────────
router.get("/suppliers", validateQuery(v.listSuppliers), c.listSuppliers);
router.post("/suppliers", validate(v.createSupplier), c.createSupplier);
router.get("/suppliers/:id", c.getSupplier);
router.put("/suppliers/:id", validate(v.updateSupplier), c.updateSupplier);

// ── Purchases ────────────────────────────────────────────────────────────────
router.get("/purchases", validateQuery(v.listPurchases), c.listPurchases);
router.post("/purchases", validate(v.createPurchase), c.createPurchase);
router.get("/purchases/:id", c.getPurchase);
router.post("/purchases/:id/cancel", c.cancelPurchase);

// ── Billing: returns / credit notes, payments ────────────────────────────────
router.post("/orders/:id/returns", validate(v.createReturn), c.createReturn);
router.get("/returns", validateQuery(v.listReturns), c.listReturns);
router.get("/returns/:id", c.getReturn);
router.get("/payments", validateQuery(v.listPayments), c.listPayments);

// ── Settings ─────────────────────────────────────────────────────────────────
router.get("/settings", c.getSettings);
router.put("/settings", validate(v.updateSettings), c.updateSettings);

// ── The store's OWN UPI QR (migration 044) ───────────────────────────────────
// Patients pay it directly; the pharmacy confirms receipt per order
// (POST /medicine/orders/groups/:id/payment/confirm-received). Always the
// signed-in pharmacy's row — no id in the path.
router.get("/payment-qr", paymentQr.get);
router.put("/payment-qr", validate(paymentQrSchema.updatePaymentQr), paymentQr.update);
router.post("/payment-qr/image", upload.single("file"), paymentQr.uploadImage);
router.delete("/payment-qr", paymentQr.remove);

module.exports = router;
