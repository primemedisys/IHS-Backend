-- ============================================================================
-- 037 — Medicine images + substitute medicines
--
-- Both hang off the GLOBAL medicine master (035), not a provider's inventory:
--
--   medicine_master_images       — up to 4 package / strip photos per medicine,
--                                  stored through the existing upload.service
--                                  (local disk or S3); sort_order 0 = primary.
--   medicine_master_substitutes  — "B substitutes for A": a self-referencing
--                                  M:N between existing masters. No medicine is
--                                  ever copied; price / stock of a substitute
--                                  come from real provider inventory rows.
--
-- Additive only: two new tables, nothing altered, dropped or deleted.
-- Idempotent (information_schema-guarded) like 013–036. The same DDL runs at
-- boot from src/db/ensureMedicineMedia.js.
-- ============================================================================

-- ── 1. medicine_master_images ───────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_master_images');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_master_images (
     id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
     medicine_master_id  BIGINT UNSIGNED   NOT NULL,
     image_url           VARCHAR(512)      NOT NULL,
     storage_key         VARCHAR(512)      NULL,
     sort_order          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
     uploaded_by         BIGINT UNSIGNED   NULL,
     created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mmi_master_order (medicine_master_id, sort_order),
     CONSTRAINT fk_mmi_master   FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mmi_uploader FOREIGN KEY (uploaded_by)        REFERENCES users (id)            ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. medicine_master_substitutes ──────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_master_substitutes');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_master_substitutes (
     id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     medicine_master_id    BIGINT UNSIGNED NOT NULL,
     substitute_master_id  BIGINT UNSIGNED NOT NULL,
     created_by            BIGINT UNSIGNED NULL,
     created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mms_pair (medicine_master_id, substitute_master_id),
     KEY idx_mms_substitute (substitute_master_id),
     CONSTRAINT fk_mms_master     FOREIGN KEY (medicine_master_id)   REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mms_substitute FOREIGN KEY (substitute_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mms_creator    FOREIGN KEY (created_by)           REFERENCES users (id)            ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
