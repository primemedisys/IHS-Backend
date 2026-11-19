-- ============================================================================
-- 026 — Follow-up is per CONSULTATION, not per patient (docs/follow-up-status)
--
-- 025 keyed patient_follow_ups on (doctor_id, patient_id): one current status
-- per doctor↔patient pair. That made the tag a property of the PERSON, so
-- changing it on one consultation rewrote it on every appointment that patient
-- had with that doctor — past visits included.
--
-- A follow-up is a decision made AT a consultation ("seen today, back in four
-- weeks"), so it belongs to the booking. Re-keying on booking_id lets one
-- patient carry a different status per visit and leaves history alone.
--
-- The doctor_id / patient_id columns stay: they are what the roster filters and
-- counts by, and keeping them saves a join on every list read.
--
-- Idempotent (information_schema-guarded) like 013-025.
-- ============================================================================

-- ── 1. Attach any pre-026 row to a real booking ─────────────────────────────
-- Rows written before the composer sent bookingId, plus 025's backfill from the
-- old ENUM, have booking_id NULL. Give them the doctor's most recent booking
-- with that patient — the visit the status was almost certainly set at.
UPDATE patient_follow_ups pfu
SET pfu.booking_id = (
  SELECT b.id FROM bookings b
  WHERE b.doctor_id = pfu.doctor_id AND b.patient_id = pfu.patient_id
  ORDER BY b.slot_date DESC, b.id DESC
  LIMIT 1
)
WHERE pfu.booking_id IS NULL;

-- A patient with no booking at all cannot own a per-consultation tag. There is
-- nothing to preserve — the status was unreachable from any screen.
DELETE FROM patient_follow_ups WHERE booking_id IS NULL;

-- ── 2. Re-key on the booking ────────────────────────────────────────────────
-- Two rows for one booking can't exist (the old PK allowed only one per pair),
-- so no de-duplication pass is needed before the new key goes on.
SET @pk := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups'
    AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'booking_id');

-- Split into two ALTER TABLE statements on purpose: MySQL 8 can raise
-- "Duplicate foreign key constraint name" when a DROP FOREIGN KEY and an ADD
-- CONSTRAINT of the SAME name appear together in one ALTER TABLE (the ADD's
-- name-uniqueness check runs before the DROP is applied).
SET @ddl1 := IF(@pk = 0,
  'ALTER TABLE patient_follow_ups
     DROP FOREIGN KEY fk_pfu_booking,
     MODIFY booking_id BIGINT UNSIGNED NOT NULL,
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (booking_id),
     ADD KEY idx_pfu_doctor_patient (doctor_id, patient_id)',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @ddl2 := IF(@pk = 0,
  'ALTER TABLE patient_follow_ups
     ADD CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;
