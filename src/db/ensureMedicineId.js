/**
 * Dev-only parity shim: adds the optional `medicine_id` column to
 * `prescription_items` if it doesn't already exist.
 *
 * The column is nullable and backward-compatible — existing rows keep working.
 */
const { QueryTypes } = require("sequelize");

async function ensureMedicineId(sequelize) {
  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'prescription_items' AND column_name = 'medicine_id'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(c) > 0) return false;
  await sequelize.query(
    `ALTER TABLE prescription_items
       ADD COLUMN medicine_id BIGINT UNSIGNED DEFAULT NULL AFTER sort_order,
       ADD CONSTRAINT fk_rxitem_medicine FOREIGN KEY (medicine_id) REFERENCES medicines (id) ON DELETE SET NULL`
  );
  return true;
}

module.exports = ensureMedicineId;
