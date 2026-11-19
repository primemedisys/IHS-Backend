/**
 * Dev-only parity shim for migration 025 (docs/follow-up-status).
 *
 * The two follow-up tables ARE defined as models, so on a dev database that
 * booted before the migration ran, `sequelize.sync()` created them FIRST — and
 * sync cannot express `TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE
 * CURRENT_TIMESTAMP`. It produced `datetime NOT NULL` with no default instead,
 * so the migration's backfill INSERT (which does not name `updated_at`) wrote
 * NULL, and Sequelize hydrated that as an Invalid Date — which threw
 * `RangeError: Invalid time value` out of the serializer and 500'd the whole
 * bookings list.
 *
 * This realigns the column with the migration and repairs any row already
 * written. Idempotent — a no-op once the column carries its default.
 */
const { QueryTypes } = require("sequelize");

async function ensureFollowUpColumns(sequelize) {
  const [table] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_follow_ups'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(table.t) === 0) return false;

  const [column] = await sequelize.query(
    `SELECT COLUMN_DEFAULT AS def, IS_NULLABLE AS nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'patient_follow_ups'
         AND column_name = 'updated_at'`,
    { type: QueryTypes.SELECT }
  );
  if (column && column.def) return false; // already has CURRENT_TIMESTAMP

  // Repair before the ALTER: a NOT NULL column cannot be re-typed while it
  // holds NULLs on a strict server.
  await sequelize.query(`UPDATE patient_follow_ups SET updated_at = NOW() WHERE updated_at IS NULL`);
  await sequelize.query(
    `ALTER TABLE patient_follow_ups
       MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
  );
  return true;
}

/**
 * Dev-only parity shim for migration 026 — re-key on the BOOKING.
 *
 * `sequelize.sync()` never rewrites a primary key, so a dev database created
 * under 025 keeps the (doctor_id, patient_id) key, where re-tagging one
 * consultation silently rewrote every other appointment that patient had.
 */
async function ensureFollowUpPerBooking(sequelize) {
  const [table] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_follow_ups'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(table.t) === 0) return false;

  const [pk] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups'
         AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'booking_id'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(pk.n) > 0) return false; // already keyed on the booking

  // Pre-026 rows may have no booking — attach them to the doctor's latest
  // visit with that patient, and drop the ones with no visit at all.
  await sequelize.query(
    `UPDATE patient_follow_ups pfu
       SET pfu.booking_id = (
         SELECT b.id FROM bookings b
         WHERE b.doctor_id = pfu.doctor_id AND b.patient_id = pfu.patient_id
         ORDER BY b.slot_date DESC, b.id DESC LIMIT 1)
     WHERE pfu.booking_id IS NULL`
  );
  await sequelize.query(`DELETE FROM patient_follow_ups WHERE booking_id IS NULL`);

  // sync() may not have created the FK, so drop it defensively.
  const [fk] = await sequelize.query(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups'
         AND COLUMN_NAME = 'booking_id' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    { type: QueryTypes.SELECT }
  );
  if (fk?.name) {
    await sequelize.query(`ALTER TABLE patient_follow_ups DROP FOREIGN KEY ${fk.name}`);
  }

  await sequelize.query(
    `ALTER TABLE patient_follow_ups
       MODIFY booking_id BIGINT UNSIGNED NOT NULL,
       DROP PRIMARY KEY,
       ADD PRIMARY KEY (booking_id),
       ADD KEY idx_pfu_doctor_patient (doctor_id, patient_id),
       ADD CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE`
  );
  return true;
}

module.exports = ensureFollowUpColumns;
module.exports.ensureFollowUpPerBooking = ensureFollowUpPerBooking;
