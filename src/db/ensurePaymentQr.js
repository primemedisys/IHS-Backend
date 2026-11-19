/**
 * Idempotent schema guard for migration 044 (provider UPI QR payments). Safe
 * on every boot, in every environment, like ensurePharmacyManagement.
 *
 * ONE source of truth for the new TABLE: its CREATE TABLE IF NOT EXISTS is
 * read straight out of migrations/044_provider_payment_qr.sql. The columns and
 * enum values this migration adds to EXISTING tables are listed below (the
 * .sql file carries the same guarded ALTERs for `npm run migrate`); each one
 * is probed in information_schema first and only applied when missing.
 *
 * Everything is ADDITIVE: no column is dropped or narrowed, the enums only
 * gain a NEW value (every existing value and default kept), and no row is
 * touched.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "044_provider_payment_qr.sql");

/** Columns added to tables that already exist. */
const COLUMNS = [
  ["payments", "offline_method", "ENUM('cash','upi_qr') NULL AFTER mode"],
  ["payments", "payer_reference", "VARCHAR(64) NULL AFTER offline_method"],
  ["payments", "payer_reported_at", "DATETIME NULL AFTER payer_reference"],
  ["medicine_payments", "payer_reference", "VARCHAR(64) NULL AFTER reference"],
  ["medicine_payments", "payer_reported_at", "DATETIME NULL AFTER payer_reference"],
].map(([table, column, definition]) => ({ table, column, definition }));

/** Enum columns widened with a new value — the full, existing list is restated. */
const ENUMS = [
  {
    table: "medicine_order_groups",
    column: "payment_method",
    value: "upi_qr",
    definition: "ENUM('cod','online','upi_qr') NOT NULL DEFAULT 'cod'",
  },
  {
    table: "medicine_payments",
    column: "method",
    value: "upi_qr",
    definition: "ENUM('cod','online','upi_qr') NOT NULL",
  },
];

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

async function columnType(sequelize, db, table, column) {
  const [rows] = await sequelize.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { db, table, column } }
  );
  return rows[0]?.type ?? null;
}

async function hasTable(sequelize, db, table) {
  const [rows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table",
    { replacements: { db, table } }
  );
  return Number(rows[0].n) > 0;
}

module.exports = async function ensurePaymentQr(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) New table — IF NOT EXISTS, so an existing one is untouched.
  for (const ddl of createStatements()) {
    await sequelize.query(ddl);
  }

  // 2) Columns on existing tables.
  for (const { table, column, definition } of COLUMNS) {
    if (!(await hasTable(sequelize, db, table))) continue;
    if (await columnType(sequelize, db, table, column)) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added ${table}.${column} (migration 044)`);
  }

  // 3) Widen the payment-method enums with 'upi_qr'.
  for (const { table, column, value, definition } of ENUMS) {
    const type = await columnType(sequelize, db, table, column);
    if (!type || type.includes(`'${value}'`)) continue;
    await sequelize.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
    console.log(`✅ Added '${value}' to ${table}.${column} (migration 044)`);
  }
};

/**
 * True when the tables this migration builds on already exist (an existing
 * database). On a brand-new dev database they don't until sync() runs.
 */
module.exports.canRun = async function canRun(sequelize) {
  const db = sequelize.getDatabaseName();
  for (const table of ["users", "payments", "medicine_order_groups", "medicine_payments"]) {
    if (!(await hasTable(sequelize, db, table))) return false;
  }
  return true;
};

module.exports.createStatements = createStatements;
module.exports.COLUMNS = COLUMNS;
module.exports.ENUMS = ENUMS;
