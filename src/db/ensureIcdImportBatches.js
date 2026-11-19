/**
 * Idempotent schema guard for migration 060 (ICD Excel import audit trail).
 * Creates icd_import_batches from the migration's own CREATE TABLE (one
 * source of truth, FK included) when it is missing. Safe on every boot; run
 * BEFORE sequelize.sync() in development so the table never comes from the
 * model without its foreign key. Touches no existing table.
 */
const fs = require("fs");
const path = require("path");
const { QueryTypes } = require("sequelize");

const MIGRATION = path.join(__dirname, "migrations", "060_icd_import_batches.sql");

function createStatements() {
  return fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s));
}

async function canRun(sequelize) {
  const rows = await sequelize.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'",
    { type: QueryTypes.SELECT }
  );
  return rows.length === 1;
}

module.exports = async function ensureIcdImportBatches(sequelize) {
  if (!(await canRun(sequelize))) return;
  for (const ddl of createStatements()) await sequelize.query(ddl);
};

module.exports.canRun = canRun;
module.exports.createStatements = createStatements;
