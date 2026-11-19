/**
 * Dev-only parity shim for the bookings double-booking guard.
 *
 * The race-safety guard is a STORED generated column (`active_lock_key`) plus a
 * UNIQUE index on it (docs/dbstruct.md §12). In production the migration
 * (005_bookings_payments.sql) creates it inline in CREATE TABLE. In development
 * the app boots with `sequelize.sync()`, which CANNOT express a generated column
 * — so `bookings` would be created without the guard. This shim adds it after
 * sync, idempotently (a no-op once the column exists), so dev == prod.
 *
 * The column is VIRTUAL (not STORED): adding a STORED generated column to an
 * existing InnoDB table forces a full table COPY that re-creates the FKs and
 * fails on MySQL 8 with errno 1215. A VIRTUAL column is added IN-PLACE (instant,
 * no rebuild) and MySQL 8 fully supports a UNIQUE secondary index on it — the
 * uniqueness guard is identical, just not materialised to disk. The 005
 * migration matches (VIRTUAL) so dev == prod.
 */
const { QueryTypes } = require("sequelize");

async function ensureBookingLockKey(sequelize) {
  /**
   * SUPERSEDED BY 027 (docs/consultation-queue).
   *
   * The guard now keys on (session_id, queue_number) — see ensureQueueColumns.
   * This shim must never re-add the slot expression on top of it, or a dev
   * machine would re-impose the "one patient per start time" cap that the whole
   * queue feature exists to remove, while production ran without it.
   */
  const [{ q }] = await sequelize.query(
    `SELECT COUNT(*) AS q FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'bookings'
         AND column_name = 'queue_number'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(q) > 0) return false; // queue-era schema — ensureQueueColumns owns the key

  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'bookings'
         AND column_name = 'active_lock_key'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(c) > 0) return false; // already present — nothing to do

  await sequelize.query(
    `ALTER TABLE bookings
       ADD COLUMN active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
         CASE WHEN status IN ('pending_payment','confirmed')
              THEN CONCAT(doctor_id, '_', slot_date, '_', slot_start_time)
              ELSE NULL END
       ) VIRTUAL,
       ADD UNIQUE KEY uq_booking_doctor_slot_lock (active_lock_key)`
  );
  return true;
}

module.exports = ensureBookingLockKey;
