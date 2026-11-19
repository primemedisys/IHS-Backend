/**
 * Idempotent schema guard for migration 057 (clinical-history consent
 * categories on doctor_access_requests). Safe on every boot: the ENUM is
 * widened only when a clinical value is missing; no row is touched.
 *
 * ONE source of truth: the ALTER statement is read straight out of
 * migrations/057_clinical_record_consent.sql.
 */
const fs = require("fs");
const path = require("path");
const { CLINICAL_ACCESS_CATEGORIES } = require("../config/constants");

const MIGRATION = path.join(__dirname, "migrations", "057_clinical_record_consent.sql");

function alterStatement() {
  return fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "");
}

module.exports = async function ensureClinicalRecordConsent(sequelize) {
  const [rows] = await sequelize.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_access_requests' AND COLUMN_NAME = 'category'"
  );
  // Table not there yet (a brand-new DB before 045 ran) — the 045 guard runs first.
  if (!rows.length) return;
  const type = String(rows[0].t);
  if (CLINICAL_ACCESS_CATEGORIES.every((c) => type.includes(`'${c}'`))) return;
  await sequelize.query(alterStatement());
};

module.exports.alterStatement = alterStatement;
