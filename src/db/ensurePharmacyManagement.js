/**
 * Idempotent schema guard for migration 043 (pharmacy management). Safe on
 * every boot, in every environment, like ensureAmbulance / ensurePharmacyOrdering.
 *
 * ONE source of truth for the new TABLES: the CREATE TABLE IF NOT EXISTS
 * statements are read straight out of migrations/043_pharmacy_management.sql
 * and run in file order. The columns / indexes / foreign keys this migration
 * adds to EXISTING tables are listed below (the .sql file carries the same
 * guarded ALTERs for `npm run migrate`); each one is probed in
 * information_schema first and only added when missing.
 *
 * Everything is ADDITIVE: no column is dropped, renamed or narrowed, no row is
 * deleted or rewritten. Existing inventory rows simply gain NULL / default
 * values (GST 0, discount 0, reorder level 10) until the pharmacy edits them.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "043_pharmacy_management.sql");

/** Columns added to tables that already exist. Order matters only for AFTER. */
const COLUMNS = [
  // Provider inventory: pricing, tax, reorder level, nearest-expiry summary, supplier.
  ["medicine_store_medicines", "sku", "VARCHAR(64) NULL AFTER medicine_master_id"],
  ["medicine_store_medicines", "hsn_code", "VARCHAR(20) NULL AFTER description"],
  ["medicine_store_medicines", "pack_size", "VARCHAR(50) NULL AFTER hsn_code"],
  ["medicine_store_medicines", "mrp", "DECIMAL(10,2) NULL AFTER pack_size"],
  ["medicine_store_medicines", "buying_price", "DECIMAL(10,2) NULL AFTER mrp"],
  ["medicine_store_medicines", "gst_rate", "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER price"],
  ["medicine_store_medicines", "discount_percent", "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER gst_rate"],
  ["medicine_store_medicines", "min_stock", "INT UNSIGNED NOT NULL DEFAULT 10 AFTER stock"],
  ["medicine_store_medicines", "batch_number", "VARCHAR(64) NULL AFTER min_stock"],
  ["medicine_store_medicines", "expiry_date", "DATE NULL AFTER batch_number"],
  ["medicine_store_medicines", "supplier_id", "BIGINT UNSIGNED NULL AFTER expiry_date"],

  // Order lines: the price / tax / cost snapshot taken when the order was placed.
  ["medicine_orders", "mrp", "DECIMAL(10,2) NULL AFTER unit_price"],
  ["medicine_orders", "discount_percent", "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER mrp"],
  ["medicine_orders", "discount_amount", "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_percent"],
  ["medicine_orders", "gst_rate", "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER discount_amount"],
  ["medicine_orders", "taxable_amount", "DECIMAL(10,2) NULL AFTER gst_rate"],
  ["medicine_orders", "gst_amount", "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_amount"],
  ["medicine_orders", "unit_cost", "DECIMAL(10,2) NULL AFTER gst_amount"],
  ["medicine_orders", "hsn_code", "VARCHAR(20) NULL AFTER unit_cost"],
  ["medicine_orders", "batch_number", "VARCHAR(64) NULL AFTER hsn_code"],
  ["medicine_orders", "expiry_date", "DATE NULL AFTER batch_number"],

  // Order header (the bill): discount and GST totals.
  ["medicine_order_groups", "discount_total", "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER subtotal"],
  ["medicine_order_groups", "taxable_total", "DECIMAL(10,2) NULL AFTER discount_total"],
  ["medicine_order_groups", "gst_total", "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_total"],

  // Tables an earlier draft of this migration created without these columns.
  ["pharmacy_purchases", "status", "ENUM('received','cancelled') NOT NULL DEFAULT 'received' AFTER invoice_date"],
  ["pharmacy_purchases", "cancelled_at", "DATETIME NULL AFTER status"],
  ["pharmacy_purchase_items", "batch_id", "BIGINT UNSIGNED NULL AFTER inventory_id"],
  ["pharmacy_purchase_items", "selling_price", "DECIMAL(10,2) NULL AFTER mrp"],
].map(([table, column, definition]) => ({ table, column, definition }));

/** Secondary indexes on existing tables. */
const INDEXES = [
  ["medicine_store_medicines", "idx_msm_provider_active", "(provider_id, is_active)"],
  ["medicine_store_medicines", "idx_msm_provider_expiry", "(provider_id, expiry_date)"],
  ["medicine_store_medicines", "idx_msm_supplier", "(supplier_id)"],
  ["medicine_order_groups", "idx_mog_provider_placed", "(provider_id, placed_at)"],
  ["pharmacy_purchase_items", "idx_ppi_batch", "(batch_id)"],
].map(([table, name, columns]) => ({ table, name, columns }));

/** Foreign keys on existing tables (the referenced tables are created first). */
const FOREIGN_KEYS = [
  ["medicine_store_medicines", "fk_msm_supplier", "(supplier_id) REFERENCES pharmacy_suppliers (id) ON DELETE SET NULL"],
  ["pharmacy_purchase_items", "fk_ppi_batch", "(batch_id) REFERENCES medicine_stock_batches (id) ON DELETE SET NULL"],
].map(([table, name, definition]) => ({ table, name, definition }));

/** The CREATE TABLE statements of the migration, in file order. */
function createStatements() {
  const sql = fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s));
}

async function exists(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return Number(rows[0].n) > 0;
}

const hasTable = (sequelize, db, table) =>
  exists(
    sequelize,
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table",
    { db, table }
  );

const hasColumn = (sequelize, db, table, column) =>
  exists(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { db, table, column }
  );

const hasIndex = (sequelize, db, table, name) =>
  exists(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND INDEX_NAME = :name`,
    { db, table, name }
  );

const hasConstraint = (sequelize, db, table, name) =>
  exists(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND CONSTRAINT_NAME = :name`,
    { db, table, name }
  );

module.exports = async function ensurePharmacyManagement(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) New tables — each statement is IF NOT EXISTS, so existing ones are untouched.
  for (const ddl of createStatements()) {
    await sequelize.query(ddl);
  }

  // 2) Columns on existing tables.
  for (const { table, column, definition } of COLUMNS) {
    if (!(await hasTable(sequelize, db, table))) continue;
    if (await hasColumn(sequelize, db, table, column)) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added ${table}.${column} (migration 043)`);
  }

  // 3) Indexes.
  for (const { table, name, columns } of INDEXES) {
    if (!(await hasTable(sequelize, db, table))) continue;
    if (await hasIndex(sequelize, db, table, name)) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD INDEX ${name} ${columns}`);
    console.log(`✅ Added index ${table}.${name} (migration 043)`);
  }

  // 4) Foreign keys.
  for (const { table, name, definition } of FOREIGN_KEYS) {
    if (!(await hasTable(sequelize, db, table))) continue;
    if (await hasConstraint(sequelize, db, table, name)) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY ${definition}`);
    console.log(`✅ Added foreign key ${table}.${name} (migration 043)`);
  }
};

/**
 * True when the tables this migration builds on already exist (an existing
 * database). On a brand-new dev database they don't until sync() runs.
 */
module.exports.canRun = async function canRun(sequelize) {
  const db = sequelize.getDatabaseName();
  for (const table of ["users", "medicine_store_medicines", "medicine_orders", "medicine_order_groups"]) {
    if (!(await hasTable(sequelize, db, table))) return false;
  }
  return true;
};

module.exports.createStatements = createStatements;
module.exports.COLUMNS = COLUMNS;
module.exports.INDEXES = INDEXES;
module.exports.FOREIGN_KEYS = FOREIGN_KEYS;
