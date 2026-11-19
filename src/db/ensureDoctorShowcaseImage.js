/**
 * Dev-only parity shim for the new `doctor_profiles.showcase_image_url` column.
 *
 * `doctor_profiles` may already exist (created by an earlier `sequelize.sync()`)
 * WITHOUT this column — and plain `sync()` never ALTERs an existing table. This
 * adds it after sync, idempotently (a no-op once present), so dev == prod
 * (migration 013 adds it for a fresh install). Mirrors ensureVitalsLocation.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [{ name: "showcase_image_url", ddl: "VARCHAR(512) NULL" }];

async function ensureDoctorShowcaseImage(sequelize) {
  // Skip if the table doesn't exist yet (sync creates it fresh from the model,
  // which already includes the column).
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'doctor_profiles'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'doctor_profiles'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false; // present — nothing to do

  await sequelize.query(
    `ALTER TABLE doctor_profiles ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensureDoctorShowcaseImage;
