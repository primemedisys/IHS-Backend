/**
 * Dev-only parity shim for `prescription_items.duration_unit`.
 *
 * `prescription_items` may already exist from an earlier `sequelize.sync()`
 * WITHOUT this column, and plain `sync()` never ALTERs an existing table. Adds
 * it after sync, idempotently, so dev == prod (migration 015 adds it on a fresh
 * install). Mirrors ensureDoctorListingToggle.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [{ name: "duration_unit", ddl: "ENUM('day','week','month') NOT NULL DEFAULT 'day'" }];

async function ensurePrescriptionDurationUnit(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'prescription_items'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'prescription_items'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false;

  await sequelize.query(
    `ALTER TABLE prescription_items ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensurePrescriptionDurationUnit;
