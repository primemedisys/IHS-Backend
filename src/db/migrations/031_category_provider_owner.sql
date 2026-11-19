-- ============================================================================
-- 031 — Category provider ownership
--
-- Adds provider_id and provider_type columns to medicine_categories so each
-- MR or Medicine Store owns their own categories. Existing global categories
-- (admin-created) remain with provider_id=NULL.
-- ============================================================================

-- Add provider_id column
SET @hasCol := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND COLUMN_NAME = 'provider_id');
SET @ddl := IF(@hasCol = 0,
  'ALTER TABLE medicine_categories ADD COLUMN provider_id BIGINT UNSIGNED NULL AFTER slug',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Add provider_type column
SET @hasCol2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND COLUMN_NAME = 'provider_type');
SET @ddl2 := IF(@hasCol2 = 0,
  "ALTER TABLE medicine_categories ADD COLUMN provider_type ENUM('mr','medicine_store') NULL AFTER provider_id",
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- Add composite unique constraint: a provider cannot have duplicate category names
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND INDEX_NAME = 'uq_mc_provider_name');
SET @ddl3 := IF(@hasIdx = 0,
  'ALTER TABLE medicine_categories ADD UNIQUE KEY uq_mc_provider_name (provider_id, name)',
  'SELECT 1');
PREPARE s3 FROM @ddl3; EXECUTE s3; DEALLOCATE PREPARE s3;

-- Add index for provider lookup
SET @hasIdx2 := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND INDEX_NAME = 'idx_mc_provider');
SET @ddl4 := IF(@hasIdx2 = 0,
  'ALTER TABLE medicine_categories ADD INDEX idx_mc_provider (provider_id, provider_type)',
  'SELECT 1');
PREPARE s4 FROM @ddl4; EXECUTE s4; DEALLOCATE PREPARE s4;
