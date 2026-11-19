/**
 * OpenAPI paths for pharmacy management (migration 043), merged into the spec
 * by config/swagger.js. Enums come straight from config/pharmacy.js so the
 * docs can't drift from the validators.
 *
 * Every path here requires a pharmacy login (medicine_store /
 * pharmacy_hospital, legacy MR) and is scoped to the signed-in pharmacy.
 */
const P = require("./pharmacy");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const multipart = (properties, required = []) => ({ content: { "multipart/form-data": { schema: { type: "object", required, properties } } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const idParam = { name: "id", in: "path", required: true, schema: { type: "integer" } };
const q = (name, schema, description) => ({ name, in: "query", schema, ...(description ? { description } : {}) });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const date = { type: "string", format: "date" };
const en = (values) => ({ type: "string", enum: [...values] });
const page = [q("page", { type: "integer", minimum: 1, default: 1 }), q("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 })];
const range = [q("from", date, "IST day, inclusive (default: 29 days before `to`)"), q("to", date, "IST day, inclusive (default: today)")];
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TAG = "Pharmacy Management";

function op(summary, description, { params = [], body, extra = {}, binary } = {}) {
  return {
    tags: [TAG],
    summary: `Pharmacy: ${summary}`,
    description,
    security: bearer,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: body } : {}),
    responses: {
      200: binary ? { description: "The spreadsheet", content: { [XLSX]: { schema: { type: "string", format: "binary" } } } } : { description: "OK — `{ success, message, data }`" },
      401: errorResponse("Not authenticated"),
      403: errorResponse("Not a pharmacy account"),
      404: errorResponse("Not found, or owned by another pharmacy"),
      422: errorResponse("Validation failure (details per field)"),
      ...extra,
    },
  };
}

const supplierProps = { name: str, contactPerson: str, phone: str, email: str, address: str, gstin: { ...str, description: "15-character GSTIN" } };
const purchaseItem = {
  type: "object",
  required: ["quantity", "buyingPrice"],
  description: "Either inventoryId (an item you stock) or medicineMasterId (a catalogue medicine — sellingPrice required when you don't stock it yet)",
  properties: {
    inventoryId: int,
    medicineMasterId: int,
    batchNumber: str,
    expiryDate: date,
    quantity: int,
    freeQuantity: { ...int, default: 0 },
    buyingPrice: { ...num, description: "Per unit, excl. GST" },
    mrp: num,
    sellingPrice: { ...num, description: "Updates your selling price" },
    gstRate: num,
    discountPercent: num,
  },
};

const pharmacyPaths = {
  "/medicine/pharmacy/dashboard": {
    get: op(
      "dashboard",
      "Real figures only: medicines, low / out of stock, expired + expiring batches (your window), stock value at cost and at selling price, today's orders and sales, pending orders, pending prescriptions, unread notifications; plus recent orders, recent purchases, low-stock items and expiring batches."
    ),
  },
  "/medicine/pharmacy/reports/sales": {
    get: op("sales report", "Sales by IST day / week / month (zero-filled): orders, gross, discount, net, taxable, GST, refunds (credit notes); breakdowns by order status, payment status and method; GROSS margin over lines with a recorded buying price (not net profit). Max range: " + P.REPORT_MAX_RANGE_DAYS + " days.", {
      params: [...range, q("groupBy", en(P.REPORT_GROUP_BY))],
      extra: { 400: errorResponse("Range invalid or too wide") },
    }),
  },
  "/medicine/pharmacy/reports/top-medicines": { get: op("top-selling medicines", "Units, revenue, orders and gross margin per medicine.", { params: [...range, q("limit", { type: "integer", maximum: 50 })] }) },
  "/medicine/pharmacy/reports/purchases": { get: op("purchase report", "Received purchases by invoice date and by supplier (cancelled purchases excluded).", { params: [...range, q("groupBy", en(P.REPORT_GROUP_BY))] }) },
  "/medicine/pharmacy/reports/gst": {
    get: op("GST summary", "By rate: GST contained in sales (output), reversed by credit notes, and paid on purchases (input), with an indicative net. Sale lines from before GST data existed are counted separately. Not a GST return.", { params: range }),
  },
  "/medicine/pharmacy/reports/stock": { get: op("stock report", "Stock summary plus a per-category breakdown (units, low / out, value at cost and at selling price).") },

  "/medicine/pharmacy/batches": {
    get: op("batches by expiry", "Every batch across the inventory, earliest expiry first. status=expiring uses `withinDays` or your Settings window.", {
      params: [q("status", en(["expired", "expiring", "valid", "all"])), q("withinDays", int), q("inStockOnly", bool), q("search", str), ...page],
    }),
  },
  "/medicine/pharmacy/batches/write-off-expired": {
    post: op("write off expired stock", "Expired batches with units are set to 0 and leave the sellable total; each write-off is recorded in the stock ledger.", {
      body: jsonBody({ type: "object", properties: { inventoryId: { ...int, description: "Only this item (default: all)" } } }),
    }),
  },
  "/medicine/pharmacy/inventory/{id}/stock": {
    post: op("receive stock without a purchase invoice", "Units into a batch (created or topped up) or, without a batch number, untracked. Recorded in the ledger.", {
      params: [idParam],
      body: jsonBody({ type: "object", required: ["quantity"], properties: { batchNumber: str, expiryDate: date, quantity: int, buyingPrice: num, mrp: num, note: str } }),
    }),
  },
  "/medicine/pharmacy/inventory/{id}/batches/{batchId}": {
    put: op("correct a batch", "SET the batch's available units and/or its expiry date. Recorded in the ledger.", {
      params: [idParam, { name: "batchId", in: "path", required: true, schema: int }],
      body: jsonBody({ type: "object", properties: { quantityAvailable: int, expiryDate: { ...date, nullable: true }, note: str } }),
    }),
  },
  "/medicine/pharmacy/inventory/{id}/movements": {
    get: op("stock history of one item", "The stock ledger, newest first: every sale, reversal, return, purchase, import, adjustment and write-off with the level after it.", {
      params: [idParam, q("type", en(Object.values(P.STOCK_MOVEMENT_TYPE))), ...page],
    }),
  },

  "/medicine/pharmacy/import/template": {
    get: op("download the Excel import template", "Columns built from the real medicine / inventory / batch fields. Sheets: Medicines (empty — the only one imported), Instructions (required / optional, formats; the image is OPTIONAL and not part of the file), Example, Lists (types, categories, your suppliers).", { binary: true }),
  },
  "/medicine/pharmacy/import/preview": {
    post: op("preview an Excel import (writes nothing)", "Validates every row and resolves it against the catalogue and your inventory: action (create / add / update / restore / skip / error), status and messages per row, plus a summary. Max " + P.IMPORT_MAX_ROWS + " rows.", {
      body: multipart({ file: { type: "string", format: "binary" }, duplicateStrategy: en(Object.values(P.IMPORT_DUPLICATE_STRATEGY)) }, ["file"]),
      extra: { 400: errorResponse("Not a readable .xlsx / .csv, missing required columns, or too many rows") },
    }),
  },
  "/medicine/pharmacy/import": {
    post: op("import an Excel file", "Re-validates the same file and writes the valid rows in ONE transaction (bulk statements). Existing catalogue medicines are reused; an item already in your inventory is skipped or (duplicateStrategy=update) updated — a blank cell keeps its current value. Stock is SET per batch, so re-importing does not double it. Error rows are never written and are returned in the report.", {
      body: multipart({ file: { type: "string", format: "binary" }, duplicateStrategy: en(Object.values(P.IMPORT_DUPLICATE_STRATEGY)) }, ["file"]),
      extra: { 400: errorResponse("Not a readable .xlsx / .csv, missing required columns, or too many rows") },
    }),
  },
  "/medicine/pharmacy/export": {
    get: op("export inventory to Excel", "Same columns as the template — one row per batch with stock plus untracked units — so it can be edited and imported back.", { params: [q("active", en(["active", "inactive", "all"]))], binary: true }),
  },

  "/medicine/pharmacy/suppliers": {
    get: op("list my suppliers", "With purchase count, value and last purchase date.", { params: [q("search", str), q("active", en(["active", "inactive", "all"])), ...page] }),
    post: op("add a supplier", "Names are unique per pharmacy (case-insensitive).", { body: jsonBody({ type: "object", required: ["name"], properties: supplierProps }), extra: { 409: errorResponse("Supplier name already exists") } }),
  },
  "/medicine/pharmacy/suppliers/{id}": {
    get: op("one supplier", "", { params: [idParam] }),
    put: op("update / deactivate a supplier", "", { params: [idParam], body: jsonBody({ type: "object", properties: { ...supplierProps, isActive: bool } }) }),
  },

  "/medicine/pharmacy/purchases": {
    get: op("list purchases", "Filter by supplier, status, invoice-date range, invoice / purchase number or medicine name, or an inventory item.", {
      params: [q("search", str), q("supplierId", int), q("status", en(Object.values(P.PURCHASE_STATUS))), q("from", date), q("to", date), q("inventoryId", int), ...page],
    }),
    post: op("record a supplier purchase (stock IN)", "Server computes every amount: gross = qty × buying price, less discount %, plus GST % (purchase prices exclude GST). Units (qty + free) go into each line's batch; the item's buying price becomes the latest rate. The same supplier invoice cannot be recorded twice.", {
      body: jsonBody({ type: "object", required: ["invoiceNumber", "invoiceDate", "items"], properties: { supplierId: int, invoiceNumber: str, invoiceDate: date, notes: str, items: { type: "array", items: purchaseItem } } }),
      extra: { 201: { description: "Purchase recorded" }, 409: errorResponse("Invoice already recorded") },
    }),
  },
  "/medicine/pharmacy/purchases/{id}": { get: op("one purchase with its lines", "", { params: [idParam] }) },
  "/medicine/pharmacy/purchases/{id}/cancel": {
    post: op("cancel a purchase", "Takes every line's units back out of its batch — all or nothing; refused when some were already sold.", { params: [idParam], extra: { 409: errorResponse("Already cancelled, or units already sold") } }),
  },

  "/medicine/pharmacy/orders/{id}/returns": {
    post: op("record a return / credit note on a delivered order", "Refund = the returned share of what each line was actually charged (after discount, GST included); the last return on a line takes exactly what is left. Restocked units go back to the batches they were sold from. A fully returned paid order becomes `refunded`. The patient is notified.", {
      params: [idParam],
      body: jsonBody({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["orderLineId", "quantity"], properties: { orderLineId: int, quantity: int } } }, reason: str, restock: { ...bool, default: true } } }),
      extra: { 201: { description: "Credit note" }, 400: errorResponse("Order not delivered, or more than was sold") },
    }),
  },
  "/medicine/pharmacy/returns": { get: op("list credit notes", "", { params: [q("search", str), q("from", date), q("to", date), ...page] }) },
  "/medicine/pharmacy/returns/{id}": { get: op("one credit note (also readable by its patient)", "With a GST summary and the store details.", { params: [idParam] }) },
  "/medicine/pharmacy/payments": {
    get: op("payment records of my orders", "The existing medicine_payments rows (COD collections and simulated online attempts). Read-only.", {
      params: [q("status", en(["pending", "success", "failed"])), q("method", en(["cod", "online"])), q("from", date), q("to", date), ...page],
    }),
  },

  "/medicine/pharmacy/settings": {
    get: op("store settings", "Registered store details + GSTIN, drug licence number, expiry alert window and bill note."),
    put: op("update store settings", "", {
      body: jsonBody({ type: "object", properties: { gstin: str, drugLicenseNumber: str, expiryAlertDays: { ...int, minimum: 1, maximum: P.MAX_EXPIRY_ALERT_DAYS }, invoiceNote: str } }),
    }),
  },
};

const pharmacyTags = [
  {
    name: TAG,
    description:
      "A pharmacy's own management system on top of the existing medicine architecture: batches + expiry, the stock ledger, suppliers, purchases, Excel import / export, returns / credit notes, payments, reports and store settings. Every route is scoped to the signed-in pharmacy.",
  },
];

module.exports = { pharmacyPaths, pharmacyTags };
