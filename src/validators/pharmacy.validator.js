/**
 * Joi validators for pharmacy management (migration 043): suppliers,
 * purchases, batches / stock corrections, returns, reports, settings and the
 * Excel import options. The field rules at the top are shared with the
 * inventory validators (medicineStore.validator), so "a GST rate" or "a batch
 * number" means the same thing on every endpoint.
 *
 * As everywhere else, money TOTALS are never accepted: a client sends prices,
 * quantities and rates; the services compute every total.
 */
const Joi = require("joi");
const { MEDICINE_ORDER_STATUS, MEDICINE_ORDER_PAYMENT_STATUS, MEDICINE_PAYMENT_METHOD } = require("../config/constants");
const {
  PURCHASE_STATUS,
  STOCK_MOVEMENT_TYPE,
  IMPORT_DUPLICATE_STRATEGY,
  REPORT_GROUP_BY,
  MAX_EXPIRY_ALERT_DAYS,
} = require("../config/pharmacy");

// ── Shared field rules ───────────────────────────────────────────────────────

const ID = Joi.number().integer().positive();
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);
const MONEY = Joi.number().min(0).max(9999999).precision(2);
const PERCENT = Joi.number().min(0).max(100).precision(2);
const QUANTITY = Joi.number().integer().min(0).max(1000000);

/** A real calendar day, 'YYYY-MM-DD' (not just the shape: 2026-02-30 is refused). */
const DAY = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((value, helpers) => {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? helpers.error("any.invalid") : value;
  })
  .messages({ "string.pattern.base": "{{#label}} must be a date in YYYY-MM-DD format", "any.invalid": "{{#label}} is not a real date" });

const BATCH_NUMBER = Joi.string().trim().max(64).pattern(/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/).messages({
  "string.pattern.base": "{{#label}} may contain only letters, numbers, spaces and . / _ -",
});

/** GSTIN: 2-digit state code, 10-character PAN, entity code, 'Z', checksum. */
const GSTIN = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
  .messages({ "string.pattern.base": "{{#label}} is not a valid 15-character GSTIN" });

const PHONE = Joi.string().trim().pattern(/^[0-9+\-\s()]{6,20}$/).messages({ "string.pattern.base": "{{#label}} is not a valid phone number" });
const TEXT = (max) => Joi.string().trim().max(max);

/**
 * The provider-owned commercial fields of an inventory row — the same rules
 * for "Add medicine", "Edit medicine" and an Excel row.
 */
const INVENTORY_FIELDS = {
  price: MONEY.greater(0),
  mrp: MONEY.greater(0).allow(null),
  buyingPrice: MONEY.allow(null),
  gstRate: PERCENT,
  discountPercent: PERCENT,
  minStock: QUANTITY,
  sku: TEXT(64).allow("", null),
  hsnCode: Joi.string().trim().pattern(/^[0-9]{2,8}$/).allow("", null).messages({ "string.pattern.base": "{{#label}} must be 2–8 digits" }),
  packSize: TEXT(50).allow("", null),
  supplierId: ID.allow(null),
};

// ── Suppliers ────────────────────────────────────────────────────────────────

const SUPPLIER_FIELDS = {
  name: TEXT(200).min(2),
  contactPerson: TEXT(150).allow("", null),
  phone: PHONE.allow("", null),
  email: Joi.string().trim().email().max(255).allow("", null),
  address: TEXT(500).allow("", null),
  gstin: GSTIN.allow("", null),
};

const createSupplier = Joi.object({ ...SUPPLIER_FIELDS, name: SUPPLIER_FIELDS.name.required() });
const updateSupplier = Joi.object({ ...SUPPLIER_FIELDS, isActive: Joi.boolean() }).min(1);
const listSuppliers = Joi.object({
  search: TEXT(100).allow("", null),
  active: Joi.string().valid("active", "inactive", "all").default("active"),
  page: PAGE,
  limit: LIMIT,
});

// ── Purchases ────────────────────────────────────────────────────────────────

/**
 * One purchase line: an item already in this pharmacy's inventory
 * (`inventoryId`), or a catalogue medicine it does not stock yet
 * (`medicineMasterId` — then a selling price is required to list it).
 */
const purchaseItem = Joi.object({
  inventoryId: ID,
  medicineMasterId: ID,
  batchNumber: BATCH_NUMBER.allow("", null),
  expiryDate: DAY.allow("", null),
  quantity: Joi.number().integer().min(1).max(1000000).required(),
  freeQuantity: Joi.number().integer().min(0).max(1000000).default(0),
  buyingPrice: MONEY.required(),
  mrp: MONEY.greater(0).allow(null),
  sellingPrice: MONEY.greater(0).allow(null),
  gstRate: PERCENT.default(0),
  discountPercent: PERCENT.default(0),
})
  .xor("inventoryId", "medicineMasterId")
  .messages({ "object.xor": "each line needs either an inventory item or a catalogue medicine", "object.missing": "each line needs either an inventory item or a catalogue medicine" });

const createPurchase = Joi.object({
  supplierId: ID.allow(null),
  invoiceNumber: TEXT(64).min(1).required(),
  invoiceDate: DAY.required(),
  notes: TEXT(500).allow("", null),
  items: Joi.array().items(purchaseItem).min(1).max(200).required(),
});

const listPurchases = Joi.object({
  search: TEXT(100).allow("", null),
  supplierId: ID,
  status: Joi.string().valid(...Object.values(PURCHASE_STATUS)),
  from: DAY,
  to: DAY,
  inventoryId: ID,
  page: PAGE,
  limit: LIMIT,
});

// ── Stock: batches, corrections, history ─────────────────────────────────────

/** Receive units into a batch (or untracked) without a purchase invoice. */
const receiveStock = Joi.object({
  batchNumber: BATCH_NUMBER.allow("", null),
  expiryDate: DAY.allow("", null),
  quantity: Joi.number().integer().min(1).max(1000000).required(),
  buyingPrice: MONEY.allow(null),
  mrp: MONEY.greater(0).allow(null),
  note: TEXT(255).allow("", null),
});

/** Correct one batch: its available units and/or its expiry. */
const updateBatch = Joi.object({
  quantityAvailable: QUANTITY,
  expiryDate: DAY.allow(null),
  note: TEXT(255).allow("", null),
}).or("quantityAvailable", "expiryDate");

const listMovements = Joi.object({
  type: Joi.string().valid(...Object.values(STOCK_MOVEMENT_TYPE)),
  page: PAGE,
  limit: LIMIT,
});

const listBatches = Joi.object({
  status: Joi.string().valid("expired", "expiring", "valid", "all").default("all"),
  withinDays: Joi.number().integer().min(1).max(MAX_EXPIRY_ALERT_DAYS),
  inStockOnly: Joi.boolean().default(true),
  search: TEXT(100).allow("", null),
  page: PAGE,
  limit: LIMIT,
});

const writeOffExpired = Joi.object({
  inventoryId: ID,
});

// ── Orders, invoices, returns ────────────────────────────────────────────────

const listProviderOrders = Joi.object({
  status: Joi.string().valid(...Object.values(MEDICINE_ORDER_STATUS)),
  paymentStatus: Joi.string().valid(...Object.values(MEDICINE_ORDER_PAYMENT_STATUS)),
  paymentMethod: Joi.string().valid(...Object.values(MEDICINE_PAYMENT_METHOD)),
  search: TEXT(100).allow("", null),
  from: DAY,
  to: DAY,
  medicineId: ID,
  page: PAGE,
  limit: LIMIT,
});

const createReturn = Joi.object({
  items: Joi.array()
    .items(Joi.object({ orderLineId: ID.required(), quantity: Joi.number().integer().min(1).max(9999).required() }))
    .min(1)
    .max(100)
    .unique("orderLineId")
    .required(),
  reason: TEXT(500).allow("", null),
  /** Put the units back on the shelf (sealed, in date) — or not (damaged / opened). */
  restock: Joi.boolean().default(true),
});

const listReturns = Joi.object({
  search: TEXT(100).allow("", null),
  from: DAY,
  to: DAY,
  page: PAGE,
  limit: LIMIT,
});

const listPayments = Joi.object({
  status: Joi.string().valid("pending", "success", "failed"),
  method: Joi.string().valid(...Object.values(MEDICINE_PAYMENT_METHOD)),
  from: DAY,
  to: DAY,
  page: PAGE,
  limit: LIMIT,
});

// ── Reports ──────────────────────────────────────────────────────────────────

const reportRange = Joi.object({
  from: DAY,
  to: DAY,
  groupBy: Joi.string().valid(...REPORT_GROUP_BY).default("day"),
  limit: Joi.number().integer().min(1).max(50).default(10),
});

// ── Settings ─────────────────────────────────────────────────────────────────

const updateSettings = Joi.object({
  gstin: GSTIN.allow("", null),
  drugLicenseNumber: TEXT(64).allow("", null),
  expiryAlertDays: Joi.number().integer().min(1).max(MAX_EXPIRY_ALERT_DAYS),
  invoiceNote: TEXT(500).allow("", null),
}).min(1);

// ── Excel import ─────────────────────────────────────────────────────────────

const exportInventory = Joi.object({
  active: Joi.string().valid("active", "inactive", "all").default("active"),
});

const importOptions = Joi.object({
  duplicateStrategy: Joi.string()
    .valid(...Object.values(IMPORT_DUPLICATE_STRATEGY))
    .default(IMPORT_DUPLICATE_STRATEGY.SKIP),
});

module.exports = {
  // shared rules (used by medicineStore.validator)
  ID,
  MONEY,
  PERCENT,
  QUANTITY,
  DAY,
  BATCH_NUMBER,
  INVENTORY_FIELDS,
  // endpoints
  createSupplier,
  updateSupplier,
  listSuppliers,
  createPurchase,
  listPurchases,
  receiveStock,
  updateBatch,
  listMovements,
  listBatches,
  writeOffExpired,
  listProviderOrders,
  createReturn,
  listReturns,
  listPayments,
  reportRange,
  updateSettings,
  exportInventory,
  importOptions,
};
