/**
 * Idempotent schema guard for migration 049 (affiliations, fellowships,
 * expertise + the new optional portfolio columns). Safe on every boot:
 *   - creates the three new tables from the migration's own CREATE TABLE
 *     statements (one source of truth, FKs included) — run BEFORE
 *     sequelize.sync() so they never come from the models without their keys;
 *   - adds each new column when missing, using the exact ALTER the migration
 *     declares (parsed out of the file, so the two can never drift).
 * Nothing existing is altered beyond adding NULLable/defaulted columns; no row
 * is touched.
 */
const fs = require("fs");
const path = require("path");
const { QueryTypes } = require("sequelize");

const MIGRATION = path.join(__dirname, "migrations", "049_doctor_portfolio_sections.sql");

function migrationSql() {
  return fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** The CREATE TABLE IF NOT EXISTS statements, in file order. */
function createStatements() {
  return migrationSql()
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s));
}

/** [{ table, column, ddl }] for every guarded ADD COLUMN in the migration. */
function columnAdditions() {
  const out = [];
  const re = /'(ALTER TABLE (\w+) ADD COLUMN (\w+) [^']+)'/g;
  for (const m of migrationSql().matchAll(re)) out.push({ ddl: m[1], table: m[2], column: m[3] });
  return out;
}

async function hasTable(sequelize, table) {
  const [{ n }] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table",
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(n) > 0;
}

/** Existing column names per table, in ONE query (no probe per column). */
async function existingColumns(sequelize, tables) {
  const rows = await sequelize.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)`,
    { type: QueryTypes.SELECT, replacements: { tables } }
  );
  const map = new Map(tables.map((t) => [t, new Set()]));
  for (const { t, c } of rows) map.get(t)?.add(c);
  return map;
}

module.exports = async function ensureDoctorPortfolioSections(sequelize) {
  if (!(await hasTable(sequelize, "doctor_profiles"))) return;
  for (const ddl of createStatements()) await sequelize.query(ddl);

  const additions = columnAdditions();
  const tables = [...new Set(additions.map((a) => a.table))];
  const columns = await existingColumns(sequelize, tables);
  // Sequential on purpose: each ALTER may reference a column (AFTER x) that the
  // previous one just added. Tables that don't exist yet are skipped — sync()
  // creates them from the models, which already carry these columns.
  for (const { table, column, ddl } of additions) {
    const have = columns.get(table);
    if (!have || have.size === 0 || have.has(column)) continue;
    await sequelize.query(ddl);
    have.add(column);
  }
};

/** The new tables reference doctor_profiles — it must exist first. */
module.exports.canRun = (sequelize) => hasTable(sequelize, "doctor_profiles");
module.exports.createStatements = createStatements;
module.exports.columnAdditions = columnAdditions;
