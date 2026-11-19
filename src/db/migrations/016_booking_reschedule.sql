-- ============================================================================
-- 016 — Appointment reschedule audit
--
-- A doctor who can't make a slot moves the appointment rather than cancelling
-- it. These two columns record that it happened and why, so the patient sees
-- "moved from 10:00 — reason" instead of the time silently changing under them.
--
-- Both NULL for every existing row: nothing has been rescheduled yet.
-- Idempotent (guarded via information_schema) like 013/014/015.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND COLUMN_NAME = 'rescheduled_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE bookings ADD COLUMN rescheduled_at DATETIME NULL, ADD COLUMN rescheduled_reason VARCHAR(255) NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
