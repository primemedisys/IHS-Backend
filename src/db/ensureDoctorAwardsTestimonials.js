/**
 * Idempotent schema guard for migration 048 (award images + doctor-managed
 * testimonials). Safe on every boot:
 *   - creates doctor_testimonials from the migration's own CREATE TABLE (one
 *     source of truth, FK included) — run BEFORE sequelize.sync() so the table
 *     never comes from the model without its foreign key;
 *   - adds doctor_awards.issuer / image_url when missing.
 * Nothing existing is altered beyond adding nullable columns; no row is touched.
 */
const fs = require("fs");
const path = require("path");
const { QueryTypes } = require("sequelize");

const MIGRATION = path.join(__dirname, "migrations", "048_doctor_award_images_testimonials.sql");

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
  const [{ n }] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table",
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(n) > 0;
}

async function hasColumn(sequelize, table, column) {
  const [{ n }] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { type: QueryTypes.SELECT, replacements: { table, column } }
  );
  return Number(n) > 0;
}

const AWARD_COLUMNS = [
  ["issuer", "ALTER TABLE doctor_awards ADD COLUMN issuer VARCHAR(255) NULL AFTER title"],
  ["image_url", "ALTER TABLE doctor_awards ADD COLUMN image_url VARCHAR(512) NULL AFTER award_year"],
];

module.exports = async function ensureDoctorAwardsTestimonials(sequelize) {
  if (await hasTable(sequelize, "doctor_profiles")) {
    for (const ddl of createStatements()) await sequelize.query(ddl);
  }
  if (await hasTable(sequelize, "doctor_awards")) {
    for (const [column, ddl] of AWARD_COLUMNS) {
      if (!(await hasColumn(sequelize, "doctor_awards", column))) await sequelize.query(ddl);
    }
  }
};

/** doctor_testimonials references doctor_profiles — it must exist first. */
module.exports.canRun = (sequelize) => hasTable(sequelize, "doctor_profiles");
module.exports.createStatements = createStatements;
