/**
 * Idempotent schema guard for migration 040 (Ambulance). Safe on every boot,
 * in every environment, like ensureBloodBank — and built the same way:
 *
 * ONE source of truth for the DDL: the CREATE TABLE IF NOT EXISTS statements
 * are read straight out of migrations/040_ambulance.sql and executed one by
 * one, so the migration file and this guard can never drift. Only the
 * users.role widening (which needs an information_schema probe) lives in JS.
 *
 * Must run AFTER ensureBloodBank (and every older enum guard): each rewrites
 * users.role with the values IT knows about, so the guard that knows every
 * value goes last. Every older guard only fires when its OWN value is missing,
 * so none of them can narrow the enum again once this has run.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "040_ambulance.sql");

const ROLE_ENUM =
  "ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab','blood_bank','ambulance_provider')";

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

module.exports = async function ensureAmbulance(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) users.role += ambulance_provider (without it every provider signup
  //    fails with a data-truncation error).
  const [rows] = await sequelize.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
    { replacements: { db } }
  );
  if (rows[0] && !String(rows[0].t).includes("'ambulance_provider'")) {
    await sequelize.query(`ALTER TABLE users MODIFY COLUMN role ${ROLE_ENUM} NOT NULL DEFAULT 'patient'`);
    console.log("✅ Added 'ambulance_provider' to users.role (migration 040)");
  }

  // 2) Tables — each statement is IF NOT EXISTS, so existing tables are untouched.
  for (const ddl of createStatements()) {
    await sequelize.query(ddl);
  }
};

module.exports.createStatements = createStatements;
