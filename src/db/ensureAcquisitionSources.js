/**
 * Idempotent schema guard for migration 056 (patient acquisition sources).
 * Safe on every boot: the CREATE TABLE IF NOT EXISTS statements are read
 * straight out of the .sql file, so the migration stays the one source of
 * truth. New tables only — nothing existing is touched.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "056_patient_acquisition_sources.sql");

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

async function hasTable(sequelize, table) {
  const [rows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table",
    { replacements: { table } }
  );
  return Number(rows[0].n) > 0;
}

module.exports = async function ensureAcquisitionSources(sequelize) {
  for (const ddl of createStatements()) await sequelize.query(ddl);
};

/** The referenced tables must exist first (an existing database). */
module.exports.canRun = async function canRun(sequelize) {
  for (const table of ["users", "bookings"]) {
    if (!(await hasTable(sequelize, table))) return false;
  }
  return true;
};

module.exports.createStatements = createStatements;
