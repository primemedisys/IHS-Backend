/**
 * Dev-only parity shim for migration 024 (admin as a record author).
 *
 * `sequelize.sync()` never ALTERs an existing table, so without this an admin
 * upload fails with a data-truncation error on a source enum that has no
 * 'admin' value. Additive and idempotent — a no-op once the column already
 * lists admin.
 */
const { QueryTypes } = require("sequelize");

async function ensureRecordAdminSource(sequelize) {
  const [row] = await sequelize.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE() AND table_name = 'uploaded_records'
         AND column_name = 'source'`,
    { type: QueryTypes.SELECT }
  );
  if (!row || String(row.t).includes("admin")) return false;

  await sequelize.query(
    `ALTER TABLE uploaded_records
       MODIFY COLUMN source ENUM('patient','doctor','clinic','admin')
       NOT NULL DEFAULT 'patient'`
  );
  return true;
}

module.exports = ensureRecordAdminSource;
