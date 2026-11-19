/**
 * Dev-only parity shim for migration 019 (booking agency).
 *
 * `bookings` already exists in every dev database and `sequelize.sync()` never
 * ALTERs an existing table, so without this a clinic booking on behalf of a
 * patient fails on "Unknown column 'booked_by_user_id'".
 *
 * NULL = the patient booked it themselves (every existing row). The FK is
 * ON DELETE SET NULL so deleting a clinic never deletes a patient's appointment.
 * Idempotent — a no-op once the column exists.
 */
const { QueryTypes } = require("sequelize");

async function ensureBookingAgency(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'bookings'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false;

  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'bookings'
         AND column_name = 'booked_by_user_id'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(c) > 0) return false;

  await sequelize.query(
    `ALTER TABLE bookings
       ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL,
       ADD CONSTRAINT fk_bookings_booked_by FOREIGN KEY (booked_by_user_id)
         REFERENCES users (id) ON DELETE SET NULL`
  );
  await sequelize.query("CREATE INDEX idx_bookings_booked_by ON bookings (booked_by_user_id)");
  return true;
}

module.exports = ensureBookingAgency;
