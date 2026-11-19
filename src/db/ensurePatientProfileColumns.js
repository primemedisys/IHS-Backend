/**
 * Dev-only parity shim for the new patient_profiles columns (health records).
 *
 * `patient_profiles` may already exist (created by an earlier `sequelize.sync()`)
 * WITHOUT the emergency-contact + "no known" columns — and plain `sync()` never
 * ALTERs an existing table. This adds any missing column after sync, idempotently
 * (a no-op once present), so dev == prod (migration 010 adds them for prod).
 * Mirrors ensureClinicalNoteVitals / ensureBookingLockKey.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [
  { name: "emergency_contact_name", ddl: "VARCHAR(150) NULL" },
  { name: "emergency_contact_phone", ddl: "VARCHAR(20) NULL" },
  { name: "no_known_allergies", ddl: "TINYINT(1) NOT NULL DEFAULT 0" },
  { name: "no_known_conditions", ddl: "TINYINT(1) NOT NULL DEFAULT 0" },
];

async function ensurePatientProfileColumns(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_profiles'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'patient_profiles'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false;

  await sequelize.query(
    `ALTER TABLE patient_profiles ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensurePatientProfileColumns;
