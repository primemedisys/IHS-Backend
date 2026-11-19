/**
 * Dev-only parity shim for the two new `bookings` link columns (journey_id,
 * referral_id).
 *
 * `bookings` already exists (created by an earlier `sequelize.sync()`) WITHOUT
 * these columns — and plain `sync()` never ALTERs an existing table. This adds
 * any missing column after sync, idempotently (a no-op once present), so dev ==
 * prod (migration 011 adds them for a fresh install). Mirrors
 * ensureClinicalNoteVitals / ensurePatientProfileColumns.
 *
 * The FK constraints are left to the migration — dev doesn't need them, and
 * adding them here would fail before care_journeys/referrals exist on first boot.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [
  { name: "journey_id", ddl: "BIGINT UNSIGNED NULL" },
  { name: "referral_id", ddl: "BIGINT UNSIGNED NULL" },
];

async function ensureReferralColumns(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'bookings'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'bookings'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false;

  await sequelize.query(
    `ALTER TABLE bookings ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}

module.exports = ensureReferralColumns;
