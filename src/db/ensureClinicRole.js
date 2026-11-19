/**
 * Dev-only parity shim for migration 017 (clinic accounts).
 *
 * `users` already exists in every dev database, and `sequelize.sync()` never
 * ALTERs an existing table — so the role column there is still the original
 * three-value enum and would reject role='clinic' with a truncation error. The
 * new `clinic_profiles` / `clinic_documents` tables ARE created by sync (they
 * come from models), so only the enum needs help.
 *
 * Idempotent: a no-op once 'clinic' is in the column type. Mirrors
 * ensureDoctorListingToggle.
 */
const { QueryTypes } = require("sequelize");

const ROLE_ENUM = "ENUM('patient','doctor','admin','clinic') NOT NULL DEFAULT 'patient'";

async function ensureClinicRole(sequelize) {
  const rows = await sequelize.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
    { type: QueryTypes.SELECT }
  );
  // No users table yet — sync is about to create it from the model, which
  // already carries the four-value enum.
  if (!rows.length) return false;
  if (String(rows[0].type).includes("clinic")) return false;

  await sequelize.query(`ALTER TABLE users MODIFY role ${ROLE_ENUM}`);
  return true;
}

module.exports = ensureClinicRole;
