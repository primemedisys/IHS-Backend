/**
 * Dev-only parity shim for the clinical-notes vitals columns.
 *
 * `clinical_notes` may already exist (created by an earlier `sequelize.sync()`)
 * WITHOUT the vitals columns — and plain `sync()` never ALTERs an existing table,
 * so adding the fields to the model alone won't add the columns in dev. This shim
 * adds any missing vitals column after sync, idempotently (a no-op once present),
 * so dev == prod (the 009 migration creates them inline for a fresh install).
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [
  { name: "blood_pressure", ddl: "VARCHAR(20) NULL" },
  { name: "pulse_rate_bpm", ddl: "SMALLINT UNSIGNED NULL" },
  { name: "weight_kg", ddl: "DECIMAL(5,2) NULL" },
  { name: "height_cm", ddl: "DECIMAL(5,2) NULL" },
  { name: "temperature_f", ddl: "DECIMAL(4,1) NULL" },
  { name: "spo2_percent", ddl: "TINYINT UNSIGNED NULL" },
];

async function ensureClinicalNoteVitals(sequelize) {
  // Skip entirely if the table itself doesn't exist yet (sync creates it fresh
  // from the model, which already includes the columns).
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'clinical_notes'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'clinical_notes'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false; // all present — nothing to do

  await sequelize.query(
    `ALTER TABLE clinical_notes ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensureClinicalNoteVitals;
