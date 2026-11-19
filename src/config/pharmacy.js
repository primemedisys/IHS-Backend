/**
 * Pharmacy management constants (migration 043). The ONE place stock-movement
 * types, purchase statuses, the expiry/reorder defaults and the Excel import
 * limits are defined — models, Joi validators, services and Swagger import
 * from here.
 *
 * PRICE CONVENTIONS (used by utils/medicinePricing and every reader):
 *   - `price` on an inventory row is the pharmacy's SELLING price per unit,
 *     GST-INCLUSIVE (the retail convention in India: shelf prices and MRP
 *     include tax). GST on a sale is therefore a BREAKDOWN of what the patient
 *     pays, never an extra charge added on top of it.
 *   - `discount_percent` is the pharmacy's own item discount on that selling
 *     price; the patient is charged price × (1 − discount%).
 *   - `buying_price` is the purchase rate per unit EXCLUDING GST, which is how
 *     a supplier's purchase bill states it; purchase GST is added on top.
 *   - `gst_rate` is whatever the pharmacy stores per item — no slab is assumed.
 */
const { ADMIN_MEDICINE_LOW_STOCK_THRESHOLD, MEDICINE_ORDER_STATUS } = require("./constants");

/** medicine_stock_movements.movement_type — every way a stock count can change. */
const STOCK_MOVEMENT_TYPE = Object.freeze({
  OPENING: "opening", // stock entered when the medicine is first added
  PURCHASE: "purchase", // a recorded supplier purchase
  PURCHASE_CANCEL: "purchase_cancel", // a purchase reversed
  SALE: "sale", // a patient order took the units
  SALE_REVERSAL: "sale_reversal", // cancelled / rejected / payment-failed order gave them back
  RETURN: "return", // a delivered order's units came back (credit note, restocked)
  ADJUSTMENT: "adjustment", // a manual stock correction by the pharmacy
  IMPORT: "import", // set by an Excel import
  EXPIRY_WRITEOFF: "expiry_writeoff", // expired units removed from sellable stock
});

/** pharmacy_purchases.status. A purchase is recorded on receipt; it can only be cancelled. */
const PURCHASE_STATUS = Object.freeze({ RECEIVED: "received", CANCELLED: "cancelled" });

/** What a stock-movement row points at. */
const STOCK_REFERENCE = Object.freeze({
  ORDER_LINE: "order_line",
  PURCHASE_ITEM: "purchase_item",
  RETURN_ITEM: "return_item",
  IMPORT: "import",
});

/**
 * Reorder level used when a pharmacy has not set its own for an item. It is
 * the same figure the admin pharmacy tracker already calls "low stock", so the
 * two views can never disagree.
 */
const DEFAULT_MIN_STOCK = ADMIN_MEDICINE_LOW_STOCK_THRESHOLD;

/** "Expiring soon" window when the pharmacy has not set its own (Settings). */
const DEFAULT_EXPIRY_ALERT_DAYS = 90;
const MAX_EXPIRY_ALERT_DAYS = 730;

/** Orders that count as SALES: placed (COD, or paid online) and not called off. */
const NON_SALE_ORDER_STATUSES = Object.freeze([MEDICINE_ORDER_STATUS.CANCELLED, MEDICINE_ORDER_STATUS.REJECTED]);

/** Returns (credit notes) can only be raised against a delivered order. */
const RETURNABLE_ORDER_STATUSES = Object.freeze([MEDICINE_ORDER_STATUS.DELIVERED]);

/** Excel import guard-rails: one file, one sheet, bounded rows. */
const IMPORT_MAX_ROWS = 5000;
const IMPORT_DUPLICATE_STRATEGY = Object.freeze({ SKIP: "skip", UPDATE: "update" });

/** Reports: the widest date range one request may aggregate. */
const REPORT_MAX_RANGE_DAYS = 366;
const REPORT_GROUP_BY = Object.freeze(["day", "week", "month"]);

/** Human-facing document numbers: PO-YYYYMMDD-000123 / CN-YYYYMMDD-000123. */
const DOCUMENT_PREFIX = Object.freeze({ PURCHASE: "PO", CREDIT_NOTE: "CN" });

module.exports = {
  STOCK_MOVEMENT_TYPE,
  STOCK_REFERENCE,
  PURCHASE_STATUS,
  DEFAULT_MIN_STOCK,
  DEFAULT_EXPIRY_ALERT_DAYS,
  MAX_EXPIRY_ALERT_DAYS,
  NON_SALE_ORDER_STATUSES,
  RETURNABLE_ORDER_STATUSES,
  IMPORT_MAX_ROWS,
  IMPORT_DUPLICATE_STRATEGY,
  REPORT_MAX_RANGE_DAYS,
  REPORT_GROUP_BY,
  DOCUMENT_PREFIX,
};
