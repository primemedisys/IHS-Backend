-- ============================================================================
-- 034 — Structured Google location on users (MR / Medicine Store providers)
--
-- Providers are plain `users` rows (role 'mr' / 'medicine_store'), so their
-- registered location lives directly on this table, mirroring the structured
-- address columns already used by clinics / clinic_profiles:
--
--   address_line  VARCHAR(255)  street parts from the Google selection
--   city          VARCHAR(100)  locality (e.g. 'Bhubaneswar')
--   state         VARCHAR(100)  administrative_area_level_1 (e.g. 'Odisha')
--   pincode       VARCHAR(20)   postal_code
--   lat / lng     DECIMAL(10,7) Google geometry (null-island never stored)
--
-- All nullable with NO backfill: pre-existing provider registrations have no
-- Google location, and inventing coordinates/place data would be fabrication.
-- Existing rows keep NULL and only new Google-selected registrations populate
-- the columns.
--
-- Idempotent (information_schema-guarded) like 013-033.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'address_line');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN address_line VARCHAR(255) NULL AFTER profile_photo_url',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'city');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN city VARCHAR(100) NULL AFTER address_line',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'state');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN state VARCHAR(100) NULL AFTER city',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pincode');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN pincode VARCHAR(20) NULL AFTER state',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lat');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN lat DECIMAL(10,7) NULL AFTER pincode',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lng');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN lng DECIMAL(10,7) NULL AFTER lat',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;