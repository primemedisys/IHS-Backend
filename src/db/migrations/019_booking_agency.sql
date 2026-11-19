-- ============================================================================
-- 019 — Booking agency ("X Clinic booked this for Y patient")
--
-- One column on bookings. NULL means the patient booked it themselves, which is
-- every existing row and every row the direct patient→doctor flow will keep
-- creating — that flow is completely untouched by this feature.
--
-- ON DELETE SET NULL, not CASCADE: deleting a clinic account must never delete
-- a patient's appointment or its prescription. The booking survives and simply
-- loses the "booked by" attribution.
--
-- The doctor's appointment list reads this to show "booked by X Clinic", and the
-- patient's prescription view reads it to show "consulted Dr. A via X Clinic".
--
-- Idempotent (information_schema-guarded) like 013-018.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND COLUMN_NAME = 'booked_by_user_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE bookings
     ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_bookings_booked_by FOREIGN KEY (booked_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- The clinic's own "appointments I booked" list filters on this.
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND INDEX_NAME = 'idx_bookings_booked_by');
SET @ddl := IF(@hasIdx = 0,
  'CREATE INDEX idx_bookings_booked_by ON bookings (booked_by_user_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
