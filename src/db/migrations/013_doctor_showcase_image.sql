-- ============================================================================
-- 013 — Doctor showcase image
--
-- One new doctor_profiles column: the doctor-chosen picture for the
-- "Why Choose <name>" section of the public portfolio. NULL means the frontend
-- falls back to the bundled stock image (/clinic_stock.png), so existing
-- profiles keep rendering unchanged. Idempotent (guarded via
-- information_schema) like 004's column adds.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'showcase_image_url');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN showcase_image_url VARCHAR(512) NULL AFTER public_email', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
