/**
 * Dev-only parity shim for the new `patient_vitals.location` column.
 *
 * `patient_vitals` may already exist (created by an earlier `sequelize.sync()`)
 * WITHOUT this column — and plain `sync()` never ALTERs an existing table. This
 * adds it after sync, idempotently (a no-op once present), so dev == prod
 * (migration 012 adds it for a fresh install). Mirrors ensureReferralColumns /
 * ensureClinicalNoteVitals.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [{ name: "location", ddl: "VARCHAR(150) NULL" }];

async function ensureVitalsLocation(sequelize) {
  // Skip if the table doesn't exist yet (sync creates it fresh from the model,
  // which already includes the column).
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_vitals'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'patient_vitals'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false; // present — nothing to do

  await sequelize.query(
    `ALTER TABLE patient_vitals ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensureVitalsLocation;
