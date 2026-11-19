/**
 * Idempotent schema guard for migration 055 (patient medicine routines, dose
 * tracking, reminder settings). Safe on every boot, like ensurePaymentQr.
 *
 * The CREATE TABLE statements are read straight out of the .sql file, so the
 * migration stays the one source of truth. Columns added to EXISTING tables
 * are probed in information_schema and only applied when missing. Additive
 * only: nothing is dropped, narrowed or rewritten.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "055_patient_medicine_routines.sql");

const COLUMNS = [
  ["medicines", "generic_name", "VARCHAR(255) NULL AFTER name"],
  ["medicines", "manufacturer", "VARCHAR(255) NULL"],
  ["medicines", "description", "TEXT NULL"],
  ["medicines", "medicine_master_id", "BIGINT UNSIGNED NULL AFTER doctor_id"],
  ["medicine_masters", "created_by_role", "VARCHAR(30) NULL AFTER created_by"],
].map(([table, column, definition]) => ({ table, column, definition }));

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

async function hasTable(sequelize, db, table) {
  const [rows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table",
    { replacements: { db, table } }
  );
  return Number(rows[0].n) > 0;
}

async function hasColumn(sequelize, db, table, column) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { db, table, column } }
  );
  return Number(rows[0].n) > 0;
}

async function hasConstraint(sequelize, db, table, name) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND CONSTRAINT_NAME = :name`,
    { replacements: { db, table, name } }
  );
  return Number(rows[0].n) > 0;
}

module.exports = async function ensurePatientMedicines(sequelize) {
  const db = sequelize.getDatabaseName();

  for (const { table, column, definition } of COLUMNS) {
    if (!(await hasTable(sequelize, db, table))) continue;
    if (await hasColumn(sequelize, db, table, column)) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added ${table}.${column} (migration 055)`);
  }
  if (
    (await hasColumn(sequelize, db, "medicines", "medicine_master_id")) &&
    !(await hasConstraint(sequelize, db, "medicines", "fk_medicines_master"))
  ) {
    await sequelize.query(
      "ALTER TABLE medicines ADD CONSTRAINT fk_medicines_master FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL"
    );
  }

  for (const ddl of createStatements()) {
    await sequelize.query(ddl);
  }
};

/** The tables the new ones reference must exist first (an existing database). */
module.exports.canRun = async function canRun(sequelize) {
  const db = sequelize.getDatabaseName();
  for (const table of ["users", "prescriptions", "prescription_items", "medicine_masters", "medicines"]) {
    if (!(await hasTable(sequelize, db, table))) return false;
  }
  return true;
};

module.exports.createStatements = createStatements;
