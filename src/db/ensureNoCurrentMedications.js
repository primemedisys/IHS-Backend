/**
 * Dev-only parity shim for migration 020 ("no current medications").
 *
 * `patient_profiles` already exists in every dev database and
 * `sequelize.sync()` never ALTERs an existing table, so without this the
 * Reported-history form fails on "Unknown column 'no_current_medications'".
 *
 * DEFAULT 0 = "not answered", which is what every existing profile means today.
 * Idempotent — a no-op once the column exists.
 */
const { QueryTypes } = require("sequelize");

async function ensureNoCurrentMedications(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_profiles'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'patient_profiles'
         AND column_name = 'no_current_medications'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(c) > 0) return false;

  await sequelize.query(
    `ALTER TABLE patient_profiles
       ADD COLUMN no_current_medications TINYINT(1) NOT NULL DEFAULT 0
         AFTER no_known_conditions`
  );
  return true;
}

module.exports = ensureNoCurrentMedications;
