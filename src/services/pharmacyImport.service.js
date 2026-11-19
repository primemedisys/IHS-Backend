/**
 * Excel import / export of a pharmacy's inventory (migration 043).
 *
 * The columns are NOT invented: each one is a real field of the existing
 * medicine model — the global master's identity (name, strength, type, plus
 * generic / manufacturer / category / description for a medicine new to the
 * catalogue), the pharmacy's own inventory row (SKU, HSN, pack, MRP, buying /
 * selling price, GST %, discount %, reorder level, supplier) and a batch
 * (number, expiry, quantity). An IMAGE IS NOT A COLUMN: photos belong to the
 * global medicine and are uploaded later from Medicine → Edit, if at all.
 *
 *   template → fill → upload → PREVIEW (validate every row, nothing written)
 *            → IMPORT (re-validate the same file, write the valid rows)
 *
 * Matching (never a second copy of a medicine):
 *   1. the pharmacy's own SKU, when given and already used in its inventory;
 *   2. otherwise the catalogue identity NAME|STRENGTH|TYPE (utils/medicineIdentity)
 *      — an existing global master is reused, a new one created only when none matches;
 *   3. an item already in the pharmacy's inventory is SKIPPED or UPDATED
 *      (the uploader chooses) — never duplicated.
 *
 * Stock is SET, not added: a row with a batch number makes that batch hold
 * exactly that quantity; a row without one sets the untracked units. So
 * importing the same sheet twice changes nothing the second time.
 *
 * The import is ONE transaction built from bulk statements (no query per
 * row): either every valid row is written, or — on an unexpected database
 * error — none is. Rows with errors are never written and are reported back.
 */
const ExcelJS = require("exceljs");
const Joi = require("joi");
const { Op } = require("sequelize");
const {
  sequelize,
  MedicineMaster,
  MedicineStoreMedicine,
  MedicineCategory,
  MedicineStockBatch,
  MedicineStockMovement,
  PharmacySupplier,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { cleanDisplay, normalize, medicineIdentityKey } = require("../utils/medicineIdentity");
const { istToday } = require("../utils/period");
const stockService = require("./pharmacyStock.service");
const supplierService = require("./pharmacySupplier.service");
const storeService = require("./medicineStore.service");
const { MEDICINE_TYPES, ERROR_CODES } = require("../config/constants");
const {
  IMPORT_MAX_ROWS,
  IMPORT_DUPLICATE_STRATEGY,
  STOCK_MOVEMENT_TYPE,
  STOCK_REFERENCE,
  DEFAULT_MIN_STOCK,
} = require("../config/pharmacy");
const { INVENTORY_FIELDS, BATCH_NUMBER, DAY, QUANTITY } = require("../validators/pharmacy.validator");

// ── The columns (one source for template, parser, export and docs) ───────────

const COLUMNS = [
  { key: "medicineName", header: "Medicine Name", required: true, example: ["Zerodol-SP", "Pan 40"], format: "Text, up to 255 characters", notes: "Brand / product name. Together with Strength and Medicine Type it identifies the medicine in the shared catalogue.", aliases: ["medicine", "name", "product", "product name", "brand"] },
  { key: "strength", header: "Strength", example: ["100 mg/325 mg/15 mg", "40 mg"], format: "Text", notes: "Part of the medicine's identity — 500 mg and 650 mg are different medicines.", aliases: [] },
  { key: "medicineType", header: "Medicine Type", required: true, example: ["tablet", "tablet"], format: `One of: ${MEDICINE_TYPES.join(", ")}`, notes: "Dosage form. Part of the medicine's identity.", aliases: ["type", "form", "dosage form"] },
  { key: "genericName", header: "Generic Name", example: ["Aceclofenac + Paracetamol + Serratiopeptidase", "Pantoprazole"], format: "Text", notes: "Used only when the medicine is new to the catalogue.", aliases: ["generic", "composition", "salt"] },
  { key: "manufacturer", header: "Manufacturer", example: ["Ipca Laboratories", "Alkem Laboratories"], format: "Text", notes: "Used only when the medicine is new to the catalogue.", aliases: ["company", "brand owner", "mfr"] },
  { key: "category", header: "Category", example: ["", ""], format: "An existing category name", notes: "Must match a category in Categories (case does not matter). Unknown names are left blank with a warning.", aliases: [] },
  { key: "sku", header: "SKU / Item Code", example: ["ZSP-10", ""], format: "Text, up to 64 characters", notes: "Your own item code. When it matches an item already in your inventory, that item is updated.", aliases: ["sku", "item code", "code"] },
  { key: "hsnCode", header: "HSN Code", example: ["30049099", "30049099"], format: "2–8 digits", notes: "", aliases: ["hsn"] },
  { key: "packSize", header: "Pack Size", example: ["Strip of 10", "Strip of 15"], format: "Text, up to 50 characters", notes: "What one unit of stock is (the unit prices refer to).", aliases: ["pack", "unit"] },
  { key: "mrp", header: "MRP", example: [120, 155], format: "Number, e.g. 120 or 120.50", notes: "Selling price may not exceed it.", aliases: ["mrp", "max retail price"] },
  { key: "buyingPrice", header: "Buying Price (excl. GST)", example: [78.5, 98], format: "Number", notes: "Your purchase rate per unit before GST. Private — never shown to patients.", aliases: ["buying price", "purchase price", "cost", "cost price", "purchase rate", "rate"] },
  { key: "price", header: "Selling Price (incl. GST)", required: true, example: [110, 140], format: "Number greater than 0", notes: "What a patient pays per unit before your discount. GST is INCLUDED.", aliases: ["selling price", "price", "sale price", "sp"] },
  { key: "gstRate", header: "GST %", example: [12, 12], format: "Number 0–100 (blank = 0)", notes: "The GST rate included in the selling price.", aliases: ["gst", "gst rate", "tax", "tax %"] },
  { key: "discountPercent", header: "Discount %", example: [5, 0], format: "Number 0–100 (blank = 0)", notes: "Your item discount on the selling price.", aliases: ["discount", "disc", "disc %"] },
  { key: "quantity", header: "Stock Quantity", required: true, example: [100, 60], format: "Whole number, 0 or more", notes: "SETS the stock of this batch (or, without a batch, the untracked stock). Re-importing the same file does not double it.", aliases: ["stock", "quantity", "qty", "stock qty", "closing stock"] },
  { key: "minStock", header: "Min Stock (Reorder Level)", example: [20, 15], format: `Whole number (blank = ${DEFAULT_MIN_STOCK})`, notes: "At or below this the item shows as Low stock.", aliases: ["min stock", "reorder level", "minimum stock", "reorder"] },
  { key: "batchNumber", header: "Batch Number", example: ["ZSP2405A", "PN24B19"], format: "Letters, numbers, spaces, . / _ -", notes: "Recommended. Required when an expiry date is given.", aliases: ["batch", "batch no", "lot", "lot number"] },
  { key: "expiryDate", header: "Expiry Date", example: ["2027-05-31", "11/2026"], format: "YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or MM/YYYY (= end of that month)", notes: "Expired stock is never sold.", aliases: ["expiry", "exp", "exp date", "expiry date"] },
  { key: "supplier", header: "Supplier", example: ["Shree Distributors", "Shree Distributors"], format: "Text", notes: "Matched to your suppliers by name; a new name is added to your suppliers.", aliases: ["supplier name", "distributor", "vendor"] },
  { key: "description", header: "Description", example: ["", ""], format: "Text", notes: "Used only when the medicine is new to the catalogue.", aliases: [] },
];
const REQUIRED_KEYS = COLUMNS.filter((c) => c.required).map((c) => c.key);
const NUMERIC_KEYS = ["mrp", "buyingPrice", "price", "gstRate", "discountPercent", "quantity", "minStock"];
const COMMERCIAL_KEYS = ["sku", "hsnCode", "packSize", "mrp", "buyingPrice", "price", "gstRate", "discountPercent", "minStock"];
const headerText = (c) => `${c.header}${c.required ? " *" : ""}`;
const SHEET = "Medicines";

/** Header text → column key, tolerant of case, punctuation and the " *" marker. */
const slug = (v) => String(v ?? "").toLowerCase().replace(/\*/g, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9%]+/g, " ").trim();
const HEADER_LOOKUP = new Map();
for (const c of COLUMNS) {
  for (const label of [c.header, c.key, ...c.aliases]) HEADER_LOOKUP.set(slug(label), c.key);
}

/**
 * One row's fields, with the same rules the manual "Add medicine" form uses
 * (validators/pharmacy.validator), labelled with the column names so a
 * message reads "Selling Price must be greater than 0".
 */
const label = (key) => COLUMNS.find((c) => c.key === key).header;
const ROW_SCHEMA = Joi.object({
  medicineName: Joi.string().trim().max(255).required(),
  strength: Joi.string().trim().max(100).allow(""),
  medicineType: Joi.string().trim().lowercase().valid(...MEDICINE_TYPES).required().messages({ "any.only": `{{#label}} must be one of: ${MEDICINE_TYPES.join(", ")}` }),
  genericName: Joi.string().trim().max(255).allow(""),
  manufacturer: Joi.string().trim().max(255).allow(""),
  category: Joi.string().trim().max(150).allow(""),
  sku: INVENTORY_FIELDS.sku,
  hsnCode: INVENTORY_FIELDS.hsnCode,
  packSize: INVENTORY_FIELDS.packSize,
  mrp: INVENTORY_FIELDS.mrp,
  buyingPrice: INVENTORY_FIELDS.buyingPrice,
  price: INVENTORY_FIELDS.price.required(),
  gstRate: INVENTORY_FIELDS.gstRate.default(0),
  discountPercent: INVENTORY_FIELDS.discountPercent.default(0),
  quantity: QUANTITY.required(),
  minStock: INVENTORY_FIELDS.minStock.default(DEFAULT_MIN_STOCK),
  batchNumber: BATCH_NUMBER.allow("", null),
  expiryDate: DAY.allow("", null),
  supplier: Joi.string().trim().max(200).allow(""),
  description: Joi.string().trim().max(5000).allow(""),
}).prefs({ messages: { "any.required": "{{#label}} is required", "number.base": "{{#label}} must be a valid number" } });
const LABELLED_SCHEMA = ROW_SCHEMA.keys(
  Object.fromEntries(COLUMNS.map((c) => [c.key, ROW_SCHEMA.extract(c.key).label(label(c.key))]))
);

// ── Cell parsing ─────────────────────────────────────────────────────────────

/** exceljs cell values come as text, numbers, Dates, rich text, formulas or hyperlinks. */
function cellValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (value.richText) return value.richText.map((t) => t.text).join("");
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return cellValue(value.text);
    if (value.error) return "";
  }
  return value;
}

/** "₹1,250.50" / "12%" / " 100 " → number; anything else is returned for Joi to reject. */
function parseNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const cleaned = text.replace(/[₹,\s%]/g, "").replace(/^rs\.?/i, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : text;
}

const pad = (v) => String(v).padStart(2, "0");
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fullYear = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));

/**
 * Expiry as written on packs and in sheets → 'YYYY-MM-DD'. A month-only
 * expiry (05/2027, MAY-27) means "use before the end of that month", so it
 * becomes the month's last day. Day-first (Indian) order for DD/MM/YYYY.
 * Returns the original text when it cannot be read, so validation reports it.
 */
function parseExpiry(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "invalid" : `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === "number") {
    // An Excel date serial that was not formatted as a date.
    const d = new Date(Math.round((value - 25569) * 86400000));
    return value > 20000 && value < 80000 ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : String(value);
  }
  const text = String(value).trim();
  let m;
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return `${fullYear(m[3])}-${pad(m[2])}-${pad(m[1])}`;
  if ((m = text.match(/^(\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const y = fullYear(m[2]);
    return `${y}-${pad(m[1])}-${pad(lastDayOfMonth(y, Number(m[1])))}`;
  }
  if ((m = text.match(/^([a-z]{3})[a-z]*[-/ .]+(\d{2}|\d{4})$/i)) && MONTHS.includes(m[1].toLowerCase())) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    const y = fullYear(m[2]);
    return `${y}-${pad(month)}-${pad(lastDayOfMonth(y, month))}`;
  }
  return text;
}

/**
 * Read the uploaded workbook into raw row objects keyed by column. Accepts the
 * .xlsx template (first sheet, or the "Medicines" sheet) or a .csv with the
 * same headers.
 */
async function readRows(file) {
  if (!file?.buffer?.length) throw ApiError.badRequest("Upload a filled-in template (.xlsx or .csv)");
  const name = String(file.originalname || "").toLowerCase();
  const workbook = new ExcelJS.Workbook();
  try {
    if (name.endsWith(".csv") || file.mimetype === "text/csv") {
      const { Readable } = require("stream"); // eslint-disable-line global-require
      await workbook.csv.read(Readable.from(file.buffer));
    } else if (name.endsWith(".xlsx") || file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      await workbook.xlsx.load(file.buffer);
    } else {
      throw ApiError.badRequest("Upload the .xlsx template or a .csv file (old .xls files are not supported — save as .xlsx)", {
        code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.badRequest("This file could not be read as a spreadsheet — download the template and try again");
  }

  const sheet = workbook.getWorksheet(SHEET) || workbook.worksheets[0];
  if (!sheet) throw ApiError.badRequest("The file has no sheet with data");

  // Header row: the first row with any recognised column.
  let headerRow = null;
  let map = null;
  for (let r = 1; r <= Math.min(sheet.rowCount, 10); r += 1) {
    const candidate = new Map();
    sheet.getRow(r).eachCell((cell, colNumber) => {
      const key = HEADER_LOOKUP.get(slug(cellValue(cell.value)));
      if (key && ![...candidate.values()].includes(key)) candidate.set(colNumber, key);
    });
    if (candidate.size >= 2) {
      headerRow = r;
      map = candidate;
      break;
    }
  }
  if (!map) throw ApiError.badRequest("No column headers found — use the downloaded template");
  const missing = REQUIRED_KEYS.filter((k) => ![...map.values()].includes(k));
  if (missing.length) {
    throw ApiError.badRequest(`Required column(s) missing: ${missing.map(label).join(", ")}`, {
      code: ERROR_CODES.VALIDATION_ERROR,
      details: { columns: missing.map((k) => `${label(k)} is required`) },
    });
  }

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const raw = {};
    let any = false;
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = map.get(colNumber);
      if (!key) return;
      const v = cellValue(cell.value);
      if (v !== "" && v !== null) any = true;
      raw[key] = v;
    });
    if (!any) continue;
    rows.push({ rowNumber: r, raw });
    if (rows.length > IMPORT_MAX_ROWS) {
      throw ApiError.badRequest(`A file can hold at most ${IMPORT_MAX_ROWS} rows — split it into smaller files`);
    }
  }
  if (!rows.length) throw ApiError.badRequest("The file has headers but no medicine rows");
  return rows;
}

/** Validate one row's shape; returns { data, errors[], warnings[] }. */
function validateRow(raw) {
  const prepared = {};
  for (const c of COLUMNS) {
    let v = raw[c.key];
    if (v instanceof Date && c.key !== "expiryDate") v = v.toISOString().slice(0, 10);
    if (NUMERIC_KEYS.includes(c.key)) v = parseNumber(v);
    else if (c.key === "expiryDate") v = parseExpiry(v);
    else v = v === undefined || v === null ? undefined : String(v).trim();
    if (v === "" && (NUMERIC_KEYS.includes(c.key) || c.key === "expiryDate")) v = undefined;
    if (v !== undefined) prepared[c.key] = v;
  }

  const { value, error } = LABELLED_SCHEMA.validate(prepared, { abortEarly: false, convert: true });
  const errors = error ? error.details.map((d) => d.message.replace(/"/g, "")) : [];
  const warnings = [];
  if (!error) {
    if (value.mrp && value.price > value.mrp) errors.push(`Selling Price (₹${value.price}) cannot be more than the MRP (₹${value.mrp})`);
    if (value.expiryDate && !value.batchNumber) errors.push("Batch Number is required when an Expiry Date is given");
    if (value.buyingPrice !== undefined && value.buyingPrice !== null && value.price < value.buyingPrice) {
      warnings.push("Selling price is below the buying price");
    }
    if (value.batchNumber && !value.expiryDate) warnings.push("No expiry date for this batch");
    if (value.expiryDate && stockService.isExpired(value.expiryDate) && value.quantity > 0) {
      warnings.push("This batch has already expired — it will be stored but never sold");
    }
  }
  // Which cells were actually filled — on an EXISTING item only these change.
  return { data: value, provided: new Set(Object.keys(prepared)), errors, warnings };
}

// ── Planning: what each row would do (shared by preview and import) ──────────

/**
 * Validate the file and resolve every row against the database in a fixed
 * number of queries. Nothing is written.
 */
async function plan(providerId, file, { duplicateStrategy = IMPORT_DUPLICATE_STRATEGY.SKIP } = {}) {
  const rows = (await readRows(file)).map((r) => ({ ...r, ...validateRow(r.raw) }));
  const ok = rows.filter((r) => !r.errors.length);

  for (const r of ok) {
    r.identityKey = medicineIdentityKey(r.data);
    r.batchKey = stockService.normalizeBatchNumber(r.data.batchNumber) || "";
  }

  // Lookups — one query each, for the whole file.
  const skus = [...new Set(ok.map((r) => r.data.sku).filter(Boolean).map((s) => normalize(s)))];
  const [bySkuRows, masters, categories, suppliers] = await Promise.all([
    skus.length
      ? MedicineStoreMedicine.findAll({ where: { providerId, sku: { [Op.in]: skus } }, include: [{ model: MedicineMaster, as: "master", attributes: ["id", "identityKey"] }] })
      : [],
    MedicineMaster.findAll({ where: { identityKey: { [Op.in]: [...new Set(ok.map((r) => r.identityKey))] } } }),
    MedicineCategory.findAll({ attributes: ["id", "name"] }),
    PharmacySupplier.findAll({ where: { providerId }, attributes: ["id", "name", "isActive"] }),
  ]);
  const inventoryBySku = new Map(bySkuRows.map((row) => [normalize(row.sku), row]));
  const masterByKey = new Map(masters.map((m) => [m.identityKey, m]));
  const categoryByName = new Map(categories.map((c) => [normalize(c.name), c]));
  const supplierByName = new Map(suppliers.map((s) => [normalize(s.name), s]));

  // SKU match wins — but only when it names the same medicine.
  for (const r of ok) {
    const bySku = r.data.sku ? inventoryBySku.get(normalize(r.data.sku)) : null;
    if (!bySku) continue;
    if (bySku.master && bySku.master.identityKey !== r.identityKey) {
      r.errors.push(`SKU ${r.data.sku} is already used for ${bySku.medicineName}${bySku.strength ? ` ${bySku.strength}` : ""} in your inventory`);
    } else {
      r.skuInventoryId = bySku.id;
    }
  }

  const masterIds = masters.map((m) => m.id);
  const inventory = masterIds.length
    ? await MedicineStoreMedicine.findAll({
        where: { providerId, medicineMasterId: { [Op.in]: masterIds } },
        order: [["isActive", "DESC"], ["id", "ASC"]],
      })
    : [];
  const inventoryByMaster = new Map();
  for (const row of inventory) {
    const key = String(row.medicineMasterId);
    if (!inventoryByMaster.has(key)) inventoryByMaster.set(key, row);
  }

  // Duplicates inside the file + the first row of each medicine.
  const firstRowOf = new Map();
  const seenBatch = new Map();
  for (const r of rows) {
    if (r.errors.length) continue;
    const dupKey = `${r.identityKey}#${r.batchKey}`;
    if (seenBatch.has(dupKey)) {
      r.errors.push(
        r.batchKey
          ? `Duplicate of row ${seenBatch.get(dupKey)} (same medicine and batch)`
          : `Duplicate of row ${seenBatch.get(dupKey)} (same medicine, no batch number)`
      );
      continue;
    }
    seenBatch.set(dupKey, r.rowNumber);
    const first = firstRowOf.get(r.identityKey);
    if (!first) {
      firstRowOf.set(r.identityKey, r);
    } else {
      const differs = COMMERCIAL_KEYS.filter((k) => r.data[k] !== undefined && String(r.data[k] ?? "") !== String(first.data[k] ?? ""));
      if (differs.length) {
        r.warnings.push(`${differs.map(label).join(", ")} differ from row ${first.rowNumber} — row ${first.rowNumber}'s values are used for this medicine`);
      }
    }
  }

  // Action per row.
  for (const r of rows) {
    if (r.errors.length) {
      r.action = "error";
      continue;
    }
    const master = masterByKey.get(r.identityKey) || null;
    const own = master ? inventoryByMaster.get(String(master.id)) : null;
    r.master = master;
    r.existing = own;
    if (own) {
      const exists = own.isActive ? "already exists in your inventory" : "is in your inventory as removed";
      if (duplicateStrategy === IMPORT_DUPLICATE_STRATEGY.UPDATE) {
        r.action = own.isActive ? "update" : "restore";
        r.warnings.push(`Medicine ${exists} — it will be updated`);
        // A blank MRP keeps the saved one, so the price must fit under THAT.
        if (!r.provided.has("mrp") && own.mrp !== null && r.data.price > Number(own.mrp)) {
          r.errors.push(`Selling Price (₹${r.data.price}) is above the MRP saved for this medicine (₹${Number(own.mrp)})`);
          r.action = "error";
          continue;
        }
      } else {
        r.action = "skip";
        r.warnings.push(`Medicine ${exists} — skipped (choose "Update existing" to change it)`);
      }
    } else {
      r.action = master ? "add" : "create";
    }

    if (r.data.category && !categoryByName.has(normalize(r.data.category))) {
      r.warnings.push(`Category "${r.data.category}" not found — left blank (add it under Categories first)`);
    }
    r.categoryId = r.data.category ? categoryByName.get(normalize(r.data.category))?.id ?? null : null;
    if (r.data.supplier && !supplierByName.has(normalize(r.data.supplier)) && r.action !== "skip") {
      r.warnings.push(`Supplier "${r.data.supplier}" will be added to your suppliers`);
    }
  }

  const status = (r) => (r.action === "error" ? "error" : r.warnings.length ? "warning" : "valid");
  const count = (fn) => rows.filter(fn).length;
  const newMedicineKeys = new Set(rows.filter((r) => r.action === "create").map((r) => r.identityKey));
  const newSupplierNames = new Set(
    rows
      .filter((r) => r.action !== "error" && r.action !== "skip" && r.data.supplier && !supplierByName.has(normalize(r.data.supplier)))
      .map((r) => normalize(r.data.supplier))
  );

  return {
    rows,
    summary: {
      totalRows: rows.length,
      validRows: count((r) => status(r) === "valid"),
      warningRows: count((r) => status(r) === "warning"),
      errorRows: count((r) => status(r) === "error"),
      toCreate: count((r) => r.action === "create" || r.action === "add"),
      toUpdate: count((r) => r.action === "update" || r.action === "restore"),
      toSkip: count((r) => r.action === "skip"),
      newCatalogueMedicines: newMedicineKeys.size,
      newSuppliers: newSupplierNames.size,
    },
    report: rows.map((r) => ({
      row: r.rowNumber,
      medicineName: r.data?.medicineName ?? (r.raw.medicineName ? String(r.raw.medicineName) : ""),
      strength: r.data?.strength || null,
      batchNumber: r.batchKey || null,
      quantity: r.data?.quantity ?? null,
      action: r.action,
      status: status(r),
      messages: [...r.errors, ...r.warnings],
    })),
    duplicateStrategy,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Validate an uploaded file and say what importing it would do. Writes nothing. */
exports.preview = async (providerId, file, options) => {
  const { summary, report, duplicateStrategy } = await plan(providerId, file, options);
  return { summary, rows: report, duplicateStrategy, fileName: file?.originalname || null };
};

/** Import the valid rows of an uploaded file, in one transaction. */
exports.commit = async (providerId, providerType, file, options, userId = providerId) => {
  const planned = await plan(providerId, file, options);
  const writable = planned.rows.filter((r) => ["create", "add", "update", "restore"].includes(r.action));
  const fileName = file?.originalname || "spreadsheet";

  if (writable.length) {
    await sequelize.transaction(async (transaction) => {
      // 1. Catalogue medicines that do not exist yet — created once each, in bulk.
      const toCreate = new Map();
      for (const r of writable.filter((x) => x.action === "create")) {
        if (!toCreate.has(r.identityKey)) toCreate.set(r.identityKey, r);
      }
      if (toCreate.size) {
        await MedicineMaster.bulkCreate(
          [...toCreate.values()].map((r) => ({
            medicineName: cleanDisplay(r.data.medicineName),
            genericName: r.data.genericName ? cleanDisplay(r.data.genericName) : null,
            medicineType: cleanDisplay(r.data.medicineType),
            strength: r.data.strength ? cleanDisplay(r.data.strength) : null,
            manufacturer: r.data.manufacturer ? cleanDisplay(r.data.manufacturer) : null,
            description: r.data.description || null,
            categoryId: r.categoryId,
            identityKey: r.identityKey,
            createdBy: providerId,
          })),
          // Another pharmacy may have just created the same identity — reuse it.
          { transaction, ignoreDuplicates: true }
        );
      }
      const masters = await MedicineMaster.findAll({
        where: { identityKey: { [Op.in]: [...new Set(writable.map((r) => r.identityKey))] } },
        transaction,
      });
      const masterByKey = new Map(masters.map((m) => [m.identityKey, m]));

      // 2. Suppliers named in the file (find-or-create, two queries).
      const { byName: supplierByName } = await supplierService.findOrCreateByNames(
        providerId,
        writable.map((r) => r.data.supplier).filter(Boolean),
        transaction
      );
      const supplierIdOf = (r) => (r.data.supplier ? supplierByName.get(cleanDisplay(r.data.supplier).toUpperCase())?.id ?? null : null);

      // 3. Inventory rows: lock the existing ones, create the missing ones.
      const firstByKey = new Map();
      for (const r of writable) if (!firstByKey.has(r.identityKey)) firstByKey.set(r.identityKey, r);
      const location = await storeService.providerLocationLabel(providerId, transaction);
      const existingIds = [...firstByKey.values()].filter((r) => r.existing).map((r) => r.existing.id);
      const locked = await stockService.lockInventories(existingIds, transaction, { providerId });

      /**
       * The commercial fields a row sets. A NEW item takes every column (blank
       * cells → the defaults: GST 0, discount 0, reorder level 10). An
       * EXISTING item only changes where the cell was filled — a blank cell
       * keeps the pharmacy's current value instead of wiping it.
       */
      const commercial = (r, { existing }) => {
        const all = {
          sku: r.data.sku || null,
          hsnCode: r.data.hsnCode || null,
          packSize: r.data.packSize || null,
          mrp: r.data.mrp ?? null,
          buyingPrice: r.data.buyingPrice ?? null,
          price: r.data.price,
          gstRate: r.data.gstRate,
          discountPercent: r.data.discountPercent,
          minStock: r.data.minStock,
        };
        const fields = existing ? Object.fromEntries(Object.entries(all).filter(([k]) => r.provided.has(k))) : all;
        return { ...fields, ...(supplierIdOf(r) ? { supplierId: supplierIdOf(r) } : {}), isActive: true };
      };

      const newRows = [...firstByKey.values()].filter((r) => !r.existing);
      const created = newRows.length
        ? await MedicineStoreMedicine.bulkCreate(
            newRows.map((r) => {
              const master = masterByKey.get(r.identityKey);
              return {
                providerId,
                providerType,
                medicineMasterId: master.id,
                medicineName: master.medicineName,
                genericName: master.genericName,
                medicineType: master.medicineType,
                strength: master.strength,
                manufacturer: master.manufacturer,
                description: master.description,
                categoryId: master.categoryId,
                location,
                stock: 0,
                ...commercial(r, { existing: false }),
              };
            }),
            { transaction }
          )
        : [];
      const inventoryByKey = new Map();
      newRows.forEach((r, i) => inventoryByKey.set(r.identityKey, created[i]));
      for (const r of firstByKey.values()) {
        if (r.existing) {
          const row = locked.get(String(r.existing.id));
          row.set(commercial(r, { existing: true }));
          inventoryByKey.set(r.identityKey, row);
        }
      }

      // 4. Stock — SET per batch / untracked, from the current batches.
      const inventories = [...inventoryByKey.values()];
      const batchMap = await stockService.batchesByInventory(inventories.map((i) => i.id), transaction);
      const untracked = new Map(inventories.map((inv) => [String(inv.id), stockService.untrackedOf(inv, batchMap.get(String(inv.id)) || [])]));
      const newBatches = [];
      const changedBatches = new Set();
      const movements = [];

      for (const r of writable) {
        const inv = inventoryByKey.get(r.identityKey);
        const id = String(inv.id);
        const qty = r.data.quantity;
        const note = `Excel import ${fileName} · row ${r.rowNumber}`.slice(0, 255);
        if (r.batchKey) {
          const batches = batchMap.get(id);
          const batch = batches.find((b) => String(b.batchNumber).toUpperCase() === r.batchKey);
          const details = {
            expiryDate: r.data.expiryDate || (batch ? batch.expiryDate : null),
            ...(r.data.buyingPrice !== undefined && r.data.buyingPrice !== null ? { buyingPrice: r.data.buyingPrice } : {}),
            ...(r.data.mrp ? { mrp: r.data.mrp } : {}),
            ...(supplierIdOf(r) ? { supplierId: supplierIdOf(r) } : {}),
          };
          if (batch) {
            const delta = qty - Number(batch.quantityAvailable);
            batch.set({ ...details, quantityAvailable: qty, quantityReceived: Math.max(Number(batch.quantityReceived) + Math.max(delta, 0), qty) });
            changedBatches.add(batch);
            if (delta !== 0) movements.push({ inv, batch, delta, note });
          } else {
            const fresh = MedicineStockBatch.build({ ...details, providerId, inventoryId: inv.id, batchNumber: r.batchKey, quantityReceived: qty, quantityAvailable: qty });
            batches.push(fresh);
            newBatches.push(fresh);
            if (qty !== 0) movements.push({ inv, batch: fresh, delta: qty, note });
          }
        } else {
          const delta = qty - untracked.get(id);
          untracked.set(id, qty);
          if (delta !== 0) movements.push({ inv, batch: null, delta, note });
        }
      }

      if (newBatches.length) {
        const saved = await MedicineStockBatch.bulkCreate(newBatches.map((b) => b.get({ plain: true })), { transaction });
        newBatches.forEach((b, i) => b.set("id", saved[i].id));
      }
      if (changedBatches.size) {
        await MedicineStockBatch.bulkCreate([...changedBatches].map((b) => b.get({ plain: true })), {
          transaction,
          updateOnDuplicate: ["expiryDate", "quantityReceived", "quantityAvailable", "buyingPrice", "mrp", "supplierId", "updatedAt"],
        });
      }

      // 5. Totals + nearest-expiry summary on every touched inventory row, in one statement.
      for (const inv of inventories) {
        const batches = batchMap.get(String(inv.id)) || [];
        inv.set({ stock: stockService.sumAvailable(batches) + untracked.get(String(inv.id)), ...stockService.nearestBatch(batches) });
      }
      await MedicineStoreMedicine.bulkCreate(
        inventories.map((inv) => inv.get({ plain: true })),
        {
          transaction,
          updateOnDuplicate: [...COMMERCIAL_KEYS, "supplierId", "isActive", "stock", "batchNumber", "expiryDate", "updatedAt"],
        }
      );

      // 6. The ledger — one row per changed batch / untracked figure.
      const running = new Map();
      await MedicineStockMovement.bulkCreate(
        movements.map(({ inv, batch, delta, note }) => {
          const id = String(inv.id);
          // stockAfter is the running level as rows apply in file order.
          const before = running.has(id) ? running.get(id) : Number(inv.stock) - movements.filter((m) => String(m.inv.id) === id).reduce((a, m) => a + m.delta, 0);
          running.set(id, before + delta);
          return {
            providerId,
            inventoryId: inv.id,
            batchId: batch ? batch.id : null,
            movementType: STOCK_MOVEMENT_TYPE.IMPORT,
            quantity: delta,
            stockAfter: before + delta,
            referenceType: STOCK_REFERENCE.IMPORT,
            referenceId: null,
            note,
            createdBy: userId,
          };
        }),
        { transaction }
      );
    });
  }

  const imported = planned.report.filter((r) => ["create", "add", "update", "restore"].includes(r.action));
  return {
    summary: {
      totalRows: planned.summary.totalRows,
      imported: imported.length,
      created: imported.filter((r) => r.action === "create" || r.action === "add").length,
      updated: imported.filter((r) => r.action === "update" || r.action === "restore").length,
      skipped: planned.summary.toSkip,
      failed: planned.summary.errorRows,
      warnings: planned.summary.warningRows,
      newCatalogueMedicines: planned.summary.newCatalogueMedicines,
      newSuppliers: planned.summary.newSuppliers,
    },
    rows: planned.report.map((r) => ({
      ...r,
      result: r.action === "error" ? "failed" : r.action === "skip" ? "skipped" : "imported",
    })),
    duplicateStrategy: planned.duplicateStrategy,
    fileName,
    importedAt: new Date().toISOString(),
    today: istToday(),
  };
};

// ── Template + export ────────────────────────────────────────────────────────

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3B8C" } };
const REQUIRED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB42318" } };

/** A sheet with the template's styled headers, widths and the Medicine Type dropdown. */
function addMedicineSheet(workbook, rows, name = SHEET) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: headerText(c), key: c.key, width: Math.max(14, headerText(c).length + 2) }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
    cell.note = `${c.required ? "REQUIRED" : "Optional"} — ${c.format}${c.notes ? `\n${c.notes}` : ""}`;
  });
  for (const row of rows) sheet.addRow(row);

  // One range-level dropdown (no empty rows are created for it).
  const letter = sheet.getColumn(COLUMNS.findIndex((c) => c.key === "medicineType") + 1).letter;
  sheet.dataValidations.add(`${letter}2:${letter}${IMPORT_MAX_ROWS + 1}`, {
    type: "list",
    allowBlank: true,
    formulae: [`Lists!$A$2:$A$${MEDICINE_TYPES.length + 1}`],
    showErrorMessage: true,
    errorTitle: "Medicine Type",
    error: `Choose one of: ${MEDICINE_TYPES.join(", ")}`,
  });
  // Expiry as text so Excel never silently converts "05/2027" into a date serial.
  sheet.getColumn(COLUMNS.findIndex((c) => c.key === "expiryDate") + 1).numFmt = "@";
  return sheet;
}

async function addListsSheet(workbook, providerId) {
  const [categories, suppliers] = await Promise.all([
    MedicineCategory.findAll({ attributes: ["name"], order: [["name", "ASC"]] }),
    PharmacySupplier.findAll({ where: { providerId, isActive: true }, attributes: ["name"], order: [["name", "ASC"]] }),
  ]);
  const sheet = workbook.addWorksheet("Lists");
  sheet.columns = [
    { header: "Medicine Types", width: 18 },
    { header: "Categories", width: 30 },
    { header: "Your Suppliers", width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  const height = Math.max(MEDICINE_TYPES.length, categories.length, suppliers.length);
  for (let i = 0; i < height; i += 1) {
    sheet.addRow([MEDICINE_TYPES[i] || null, categories[i]?.name || null, suppliers[i]?.name || null]);
  }
}

function addInstructionsSheet(workbook) {
  const sheet = workbook.addWorksheet("Instructions");
  sheet.columns = [
    { header: "Column", key: "column", width: 28 },
    { header: "Required?", key: "required", width: 12 },
    { header: "Format", key: "format", width: 46 },
    { header: "Notes", key: "notes", width: 80 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const c of COLUMNS) {
    sheet.addRow({ column: c.header, required: c.required ? "REQUIRED" : "Optional", format: c.format, notes: c.notes });
  }
  sheet.addRow({ column: "Medicine Image", required: "Optional", format: "Not part of this file", notes: "Images are OPTIONAL. Import without them, then open Medicines → Edit to upload photos at any time." });
  sheet.addRow({});
  const general = [
    "One row = one medicine batch. List the same medicine on several rows to import several batches.",
    "Rows are matched to the shared medicine catalogue by Medicine Name + Strength + Medicine Type (case does not matter). An existing medicine is reused — never duplicated.",
    "If a medicine is already in your inventory it is skipped, unless you choose “Update existing” when importing. When updating, a blank cell keeps the current value.",
    "Stock Quantity SETS the stock of that batch (or, without a batch, your untracked stock). Importing the same file twice does not double your stock.",
    "Prices are per unit (see Pack Size). Selling Price includes GST; Buying Price excludes GST.",
    "Always Preview first: every row is checked and nothing is saved until you press Import. Rows with errors are never imported.",
    "Fill in the “Medicines” sheet — only that sheet is imported. The “Example” sheet shows two filled rows for reference.",
  ];
  sheet.addRow(["How the import works"]).font = { bold: true };
  for (const line of general) sheet.addRow(["", "", "", line]);
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
}

/**
 * The official template: an EMPTY Medicines sheet (the only one imported),
 * Instructions, an Example sheet with two filled rows, and Lists. Keeping the
 * examples off the Medicines sheet means they can never be imported by
 * accident.
 */
exports.template = async (providerId) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Indian Health System";
  workbook.created = new Date();
  addMedicineSheet(workbook, []);
  addInstructionsSheet(workbook);
  addMedicineSheet(
    workbook,
    [0, 1].map((i) => Object.fromEntries(COLUMNS.map((c) => [c.key, c.example[i] === "" ? null : c.example[i]]))),
    "Example"
  );
  await addListsSheet(workbook, providerId);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "medicine-import-template.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
};

/**
 * The pharmacy's inventory in the SAME columns as the template — one row per
 * batch with stock, plus a row for untracked units — so an export can be
 * edited and imported back.
 */
exports.exportInventory = async (providerId, { active = "active" } = {}) => {
  const where = { providerId };
  if (active === "active") where.isActive = true;
  else if (active === "inactive") where.isActive = false;
  const items = await MedicineStoreMedicine.findAll({
    where,
    include: [
      { model: MedicineCategory, as: "category", attributes: ["name"] },
      { model: PharmacySupplier, as: "supplier", attributes: ["name"] },
      { model: MedicineMaster, as: "master", attributes: ["genericName", "manufacturer", "description"] },
      { model: MedicineStockBatch, as: "batches", include: [{ model: PharmacySupplier, as: "supplier", attributes: ["name"] }] },
    ],
    order: [["medicineName", "ASC"], ["id", "ASC"]],
  });

  const rows = [];
  for (const item of items) {
    const base = {
      medicineName: item.medicineName,
      strength: item.strength,
      medicineType: item.medicineType,
      genericName: item.master?.genericName ?? item.genericName,
      manufacturer: item.master?.manufacturer ?? item.manufacturer,
      category: item.category?.name ?? null,
      sku: item.sku,
      hsnCode: item.hsnCode,
      packSize: item.packSize,
      mrp: item.mrp === null ? null : Number(item.mrp),
      buyingPrice: item.buyingPrice === null ? null : Number(item.buyingPrice),
      price: Number(item.price),
      gstRate: Number(item.gstRate),
      discountPercent: Number(item.discountPercent),
      minStock: item.minStock,
      supplier: item.supplier?.name ?? null,
      description: null,
    };
    const batches = (item.batches || []).filter((b) => b.quantityAvailable > 0).sort(stockService.byExpiry);
    for (const b of batches) {
      rows.push({ ...base, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: b.quantityAvailable, supplier: b.supplier?.name ?? base.supplier });
    }
    const untracked = stockService.untrackedOf(item, item.batches || []);
    if (untracked > 0 || !batches.length) rows.push({ ...base, batchNumber: null, expiryDate: null, quantity: untracked });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Indian Health System";
  workbook.created = new Date();
  addMedicineSheet(workbook, rows);
  addInstructionsSheet(workbook);
  await addListsSheet(workbook, providerId);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `medicine-inventory-${istToday()}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    rowCount: rows.length,
  };
};

exports.COLUMNS = COLUMNS;
exports.parseExpiry = parseExpiry;
exports.validateRow = validateRow;
