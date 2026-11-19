/**
 * Dev-only parity shim for the reschedule audit columns on `bookings`.
 *
 * `sync()` never ALTERs an existing table, so a dev DB created before
 * migration 016 would be missing them. Idempotent; mirrors the sibling shims.
 */
const { QueryTypes } = require("sequelize");

const COLUMNS = [
  { name: "rescheduled_at", ddl: "DATETIME NULL" },
  { name: "rescheduled_reason", ddl: "VARCHAR(255) NULL" },
];

async function ensureBookingRescheduleColumns(sequelize) {
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
         WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = :name`,
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

module.exports = ensureBookingRescheduleColumns;
