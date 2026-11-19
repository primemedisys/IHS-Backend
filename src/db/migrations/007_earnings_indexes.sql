-- ============================================================================
-- 007 — Dashboards & Earnings (docs/dashboards-earnings/backend-plan.md §2.3)
--
-- Three jobs, none of which add a business entity:
--   1. Refund bookkeeping columns on `payments`, so flipping a row to
--      'refunded' doesn't silently erase it from months already reported.
--   2. The composite indexes every dashboard aggregate range-scans on.
--   3. A BACKFILL of the commission split on offline payments confirmed through
--      booking.service.markPaid() before it learned to call applySplit(). Those
--      rows sit at status='success' with commission_amount = 0.00 and
--      doctor_payout_amount = 0.00 (the column defaults), which would make every
--      "pay at clinic" consult worth ₹0 to both the doctor and the platform.
--
-- Idempotent throughout (guarded DDL via information_schema, as in 004), so it
-- is safe to re-run and safe alongside a fresh base schema.
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
-- ============================================================================

-- ── 1. Refund bookkeeping on payments (README §4.3) ─────────────────────────
-- `paid_at` exists; there is no way to say WHEN a refund happened or how much
-- came back. Without these, a refund makes the row vanish from every
-- status='success' aggregate — including historical months already reported.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'refunded_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE payments ADD COLUMN refunded_at DATETIME NULL AFTER paid_at', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'refund_amount');
SET @ddl := IF(@has = 0,
  'ALTER TABLE payments ADD COLUMN refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER refunded_at',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. Aggregate indexes (README §4.2) ──────────────────────────────────────
-- MySQL 8 has no `CREATE INDEX IF NOT EXISTS`, so guard on information_schema
-- the same way 004 guards its column adds.

-- Every money query is `status='success' AND paid_at IN <range>`: leading with
-- the low-cardinality status, then range-scanning paid_at, is exactly the
-- access pattern. 005 indexed status alone, which degenerates to a full scan.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
    AND INDEX_NAME = 'idx_payment_status_paid_at');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_payment_status_paid_at ON payments (status, paid_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Doctor tiles filter (doctor_id, status) then range on slot_date. 005's
-- (doctor_id, slot_date) can't skip cancelled rows without a filesort.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
    AND INDEX_NAME = 'idx_booking_doctor_status_date');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_booking_doctor_status_date ON bookings (doctor_id, status, slot_date)',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Admin "bookings this month" ranges on slot_date across all doctors.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
    AND INDEX_NAME = 'idx_booking_status_date');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_booking_status_date ON bookings (status, slot_date)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. Backfill the offline commission split (README §4.1) ──────────────────
-- Scoped hard: only success rows whose split was never written. Re-running is a
-- no-op because the WHERE no longer matches.
--
-- The 0.15 is a LITERAL on purpose. It reconstructs what confirmPaid() stamped
-- on the contemporaneous ONLINE rows these are being reconciled against.
-- Importing PLATFORM_COMMISSION_PCT would make this migration produce different
-- results depending on when it is run; a migration must be a pure function of
-- the database. If the rate changes, this file keeps saying 0.15 forever.
UPDATE payments
   SET commission_amount    = ROUND(amount * 0.15, 2),
       doctor_payout_amount = ROUND(amount - ROUND(amount * 0.15, 2), 2)
 WHERE status = 'success'
   AND mode = 'offline'
   AND commission_amount = 0.00
   AND doctor_payout_amount = 0.00
   AND amount > 0;
