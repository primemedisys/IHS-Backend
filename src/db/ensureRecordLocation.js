/**
 * Dev-only parity shim for migration 022 (uploaded_records.location).
 *
 * `sequelize.sync()` never ALTERs an existing table, so without this saving a
 * record with a location fails on an unknown column. Idempotent.
 */
const { QueryTypes } = require("sequelize");

async function ensureRecordLocation(sequelize) {
  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'uploaded_records'
         AND column_name = 'location'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(c) > 0) return false;
  await sequelize.query("ALTER TABLE uploaded_records ADD COLUMN location VARCHAR(150) NULL AFTER tag");
  return true;
}

module.exports = ensureRecordLocation;
