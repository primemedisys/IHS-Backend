/**
 * Idempotent schema guard for migration 059 (ICD code master, coded
 * diagnoses, prescription clinical snapshot). Safe on every boot:
 *   - creates icd_codes from the migration's own CREATE TABLE (one source of
 *     truth, FKs included) — run BEFORE sequelize.sync() in development so the
 *     table never comes from the model without its keys;
 *   - adds each column / index / foreign key when missing, using the exact
 *     ALTER the migration declares (parsed out of the file, so the two can
 *     never drift).
 * Only NULLable columns are added; no row is touched.
 */
const fs = require("fs");
const path = require("path");
const { QueryTypes } = require("sequelize");

const MIGRATION = path.join(__dirname, "migrations", "059_icd_master_and_rx_clinical_snapshot.sql");

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

/** [{ table, column?, index?, constraint?, ddl }] for every guarded ALTER in the file. */
function alterations() {
  const out = [];
  const re = /'(ALTER TABLE (\w+) ADD (?:COLUMN (\w+)|INDEX (\w+)|CONSTRAINT (\w+))(?:[^']|'')*)'/g;
  for (const m of migrationSql().matchAll(re)) {
    out.push({
      ddl: m[1].replace(/''/g, "'"),
      table: m[2],
      column: m[3] || null,
      index: m[4] || null,
      constraint: m[5] || null,
    });
  }
  return out;
}

async function hasTables(sequelize, tables) {
  const rows = await sequelize.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)",
    { type: QueryTypes.SELECT, replacements: { tables } }
  );
  return rows.length === tables.length;
}

/** Existing columns, indexes and constraints per table — three queries, never one per item. */
async function existing(sequelize, tables) {
  const q = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements: { tables } });
  const [cols, idx, fks] = await Promise.all([
    q("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)"),
    q("SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)"),
    q("SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS c FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)"),
  ]);
  const toMap = (rows) => {
    const map = new Map(tables.map((t) => [t, new Set()]));
    for (const { t, c } of rows) map.get(t)?.add(c);
    return map;
  };
  return { columns: toMap(cols), indexes: toMap(idx), constraints: toMap(fks) };
}

/** icd_codes references users; the ALTERs need clinical_entries + prescriptions. */
const REQUIRED = ["users", "clinical_entries", "prescriptions"];

module.exports = async function ensureClinicalCoding(sequelize) {
  if (!(await hasTables(sequelize, REQUIRED))) return;
  for (const ddl of createStatements()) await sequelize.query(ddl);

  const list = alterations();
  const tables = [...new Set(list.map((a) => a.table))];
  const { columns, indexes, constraints } = await existing(sequelize, tables);
  // Sequential on purpose: each ALTER may reference a column (AFTER x) the
  // previous one just added, and the FK needs its column first.
  for (const { table, column, index, constraint, ddl } of list) {
    const haveCols = columns.get(table);
    if (!haveCols || haveCols.size === 0) continue;
    if (column && haveCols.has(column)) continue;
    if (index && indexes.get(table).has(index)) continue;
    if (constraint && constraints.get(table).has(constraint)) continue;
    await sequelize.query(ddl);
    if (column) haveCols.add(column);
    if (index) indexes.get(table).add(index);
    if (constraint) constraints.get(table).add(constraint);
  }
};

module.exports.canRun = (sequelize) => hasTables(sequelize, REQUIRED);
module.exports.createStatements = createStatements;
module.exports.alterations = alterations;
