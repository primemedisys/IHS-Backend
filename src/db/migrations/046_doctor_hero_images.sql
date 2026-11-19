-- ============================================================================
-- 046 — Doctor portfolio hero images
--
-- One new doctor_profiles column: up to three doctor-uploaded background
-- pictures for the public portfolio hero, stored as a JSON array of URLs in
-- display order (["https://…", "https://…"]). NULL or [] means "no images" and
-- the frontends render the plain hero, so existing profiles are unchanged.
-- The three-image cap is enforced by the API (doctor.service). Idempotent
-- (guarded via information_schema) like 013's column add.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'hero_image_urls');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN hero_image_urls JSON NULL AFTER showcase_image_url', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
