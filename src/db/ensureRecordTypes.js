/**
 * Dev-only parity shim for migration 021 (x-ray / MRI record types).
 *
 * `sequelize.sync()` never ALTERs an existing table, so without this an upload
 * chosen as "X-ray" fails with a data-truncation error on an enum that has no
 * such value. Additive and idempotent — a no-op once the column already lists
 * xray.
 */
const { QueryTypes } = require("sequelize");

async function ensureRecordTypes(sequelize) {
  const [row] = await sequelize.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE() AND table_name = 'uploaded_records'
         AND column_name = 'file_type'`,
    { type: QueryTypes.SELECT }
  );
  if (!row || String(row.t).includes("xray")) return false;

  await sequelize.query(
    `ALTER TABLE uploaded_records
       MODIFY COLUMN file_type ENUM('prescription','lab_report','xray','mri','other')
       NOT NULL DEFAULT 'prescription'`
  );
  return true;
}

module.exports = ensureRecordTypes;
