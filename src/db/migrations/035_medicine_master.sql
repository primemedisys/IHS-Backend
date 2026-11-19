-- ============================================================================
-- 035 — Global medicine master + provider inventory link
--
-- Splits medicine IDENTITY from provider INVENTORY without touching existing
-- rows:
--
--   medicine_masters                      — one row per distinct medicine,
--                                           shared by every MR / Medicine Store
--   medicine_store_medicines.medicine_master_id
--                                         — each provider's inventory row
--                                           (own price + stock) points at it
--
-- Identity = normalized NAME|STRENGTH|TYPE (trimmed, whitespace-collapsed,
-- upper-cased) stored in identity_key with a UNIQUE index, so "Jerodol-SP"
-- and "JERODOL-SP" can never become two masters.
--
-- Additive only: no column is dropped, no row deleted. The column is NULLable
-- and the one-time link of pre-existing inventory rows to masters is done by
-- src/db/ensureMedicineMaster.js at boot (it uses the SAME JS normalizer as
-- the service, so the backfill and runtime can never disagree). Duplicate
-- inventory rows a provider already has are linked to the same master and
-- left in place — nothing is merged or deleted.
--
-- Idempotent (information_schema-guarded) like 013–034.
-- ============================================================================

-- ── 1. medicine_masters ──────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_masters');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_masters (
     id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     medicine_name  VARCHAR(255)    NOT NULL,
     generic_name   VARCHAR(255)    NULL,
     medicine_type  VARCHAR(50)     NOT NULL,
     strength       VARCHAR(100)    NULL,
     manufacturer   VARCHAR(255)    NULL,
     description    TEXT            NULL,
     category_id    INT UNSIGNED    NULL,
     identity_key   VARCHAR(420)    NOT NULL,
     created_by     BIGINT UNSIGNED NULL,
     is_active      TINYINT(1)      NOT NULL DEFAULT 1,
     created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mm_identity (identity_key),
     KEY idx_mm_name     (medicine_name),
     KEY idx_mm_category (category_id),
     CONSTRAINT fk_mm_category FOREIGN KEY (category_id) REFERENCES medicine_categories (id) ON DELETE SET NULL,
     CONSTRAINT fk_mm_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. medicine_store_medicines.medicine_master_id ──────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines'
    AND COLUMN_NAME = 'medicine_master_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE medicine_store_medicines
     ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER category_id,
     ADD KEY idx_msm_master (medicine_master_id),
     ADD KEY idx_msm_provider_master (provider_id, medicine_master_id),
     ADD CONSTRAINT fk_msm_master FOREIGN KEY (medicine_master_id)
       REFERENCES medicine_masters (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
