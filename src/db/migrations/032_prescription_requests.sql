-- ============================================================================
-- 032 — Patient prescription upload & provider sharing
--
-- Adds a `prescription_requests` table so patients can upload a prescription
-- file and share it with selected medicine providers (MR / Medicine Store).
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_requests');
SET @ddl := IF(@has = 0,
  'CREATE TABLE prescription_requests (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id      BIGINT UNSIGNED NOT NULL,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     file_url        VARCHAR(512)    NOT NULL,
     file_name       VARCHAR(255)    NULL,
     notes           TEXT            NULL,
     status          ENUM(''pending'',''viewed'',''processing'',''completed'',''rejected'') NOT NULL DEFAULT ''pending'',
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_pr_patient  (patient_id),
     KEY idx_pr_provider (provider_id, provider_type),
     KEY idx_pr_status   (status),
     CONSTRAINT fk_pr_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pr_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
