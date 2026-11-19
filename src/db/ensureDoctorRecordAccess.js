/**
 * Idempotent schema guard for migration 045 (doctor record-access consent +
 * access audit log). Safe on every boot, in every environment.
 *
 * ONE source of truth: the CREATE TABLE IF NOT EXISTS statements are read
 * straight out of migrations/045_doctor_record_access.sql. Only NEW tables are
 * created; nothing existing is altered and no row is touched.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "045_doctor_record_access.sql");

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

module.exports = async function ensureDoctorRecordAccess(sequelize) {
  for (const ddl of createStatements()) {
    await sequelize.query(ddl);
  }
};

/** The tables the new ones reference must exist first (a brand-new dev DB). */
module.exports.canRun = async function canRun(sequelize) {
  const db = sequelize.getDatabaseName();
  for (const table of ["users", "uploaded_records"]) {
    if (!(await hasTable(sequelize, db, table))) return false;
  }
  return true;
};

module.exports.createStatements = createStatements;
