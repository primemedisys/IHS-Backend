-- ============================================================================
-- 014 — Doctor listing toggle
--
-- One new doctor_profiles column: the admin's public-visibility switch. It is
-- INDEPENDENT of verification_status — an approved doctor keeps their account,
-- their bookings and their dashboard, but with is_listed = 0 they vanish from
-- every patient-facing read (discovery/find-a-doctor, the map, the portfolio
-- page, related doctors, slots and new bookings).
--
-- DEFAULT 1 so every existing approved doctor stays live after the upgrade.
-- Idempotent (guarded via information_schema) like 013's column add.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'is_listed');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN is_listed TINYINT(1) NOT NULL DEFAULT 1 AFTER is_submitted', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Discovery filters on (verification_status, is_listed) on every public list.
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND INDEX_NAME = 'idx_doctor_profiles_public');
SET @ddl := IF(@hasIdx = 0,
  'CREATE INDEX idx_doctor_profiles_public ON doctor_profiles (verification_status, is_listed)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
