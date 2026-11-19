/**
 * Idempotent schema guard for migration 051 (doctor EMR workspace). Safe on
 * every dev boot:
 *   - creates clinical_entries from the migration's own CREATE TABLE (one
 *     source of truth, FKs included) — run BEFORE sequelize.sync() so the table
 *     never comes from the model without its keys;
 *   - adds each new column / index when missing, using the exact ALTER the
 *     migration declares (parsed out of the file, so the two can never drift).
 * Nothing existing is altered beyond adding NULLable/defaulted columns; no row
 * is touched.
 */
const fs = require("fs");
const path = require("path");
const { QueryTypes } = require("sequelize");

const MIGRATION = path.join(__dirname, "migrations", "051_emr_clinical_workspace.sql");

function migrationSql() {
  return fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function createStatements() {
  return migrationSql()
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s));
}

/**
 * [{ table, column?, index?, ddl }] for every guarded ALTER. The DDL sits in a
 * single-quoted SQL string where a literal quote is doubled (ENUM('day') is
 * written ENUM(''day'')), so the pattern accepts '' and un-doubles it.
 */
function alterations() {
  const out = [];
  const re = /'(ALTER TABLE (\w+) ADD (?:COLUMN (\w+)|INDEX (\w+))(?:[^']|'')*)'/g;
  for (const m of migrationSql().matchAll(re)) {
    out.push({ ddl: m[1].replace(/''/g, "'"), table: m[2], column: m[3] || null, index: m[4] || null });
  }
  return out;
}

async function hasTable(sequelize, table) {
  const [{ n }] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table",
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(n) > 0;
}

/** Existing columns + indexes per table, in two queries (no probe per item). */
async function existing(sequelize, tables) {
  const [cols, idx] = await Promise.all([
    sequelize.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)`,
      { type: QueryTypes.SELECT, replacements: { tables } }
    ),
    sequelize.query(
      `SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)`,
      { type: QueryTypes.SELECT, replacements: { tables } }
    ),
  ]);
  const toMap = (rows) => {
    const map = new Map(tables.map((t) => [t, new Set()]));
    for (const { t, c } of rows) map.get(t)?.add(c);
    return map;
  };
  return { columns: toMap(cols), indexes: toMap(idx) };
}

module.exports = async function ensureEmrWorkspace(sequelize) {
  if (!(await hasTable(sequelize, "bookings"))) return;
  for (const ddl of createStatements()) await sequelize.query(ddl);

  const list = alterations();
  const tables = [...new Set(list.map((a) => a.table))];
  const { columns, indexes } = await existing(sequelize, tables);
  // Sequential on purpose: each ALTER may reference a column (AFTER x) that the
  // previous one just added. A table that doesn't exist yet is skipped — sync()
  // creates it from the model, which already carries these columns.
  for (const { table, column, index, ddl } of list) {
    const haveCols = columns.get(table);
    if (!haveCols || haveCols.size === 0) continue;
    if (column && haveCols.has(column)) continue;
    if (index && indexes.get(table).has(index)) continue;
    await sequelize.query(ddl);
    if (column) haveCols.add(column);
    if (index) indexes.get(table).add(index);
  }
};

/** clinical_entries references users + bookings — both must exist first. */
module.exports.canRun = (sequelize) => hasTable(sequelize, "bookings");
module.exports.createStatements = createStatements;
module.exports.alterations = alterations;
