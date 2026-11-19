-- ============================================================================
-- 059 — Admin ICD code master, coded diagnoses, prescription clinical snapshot
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped; every new column is
-- NULLable, so existing rows and existing clients keep working unchanged.
--
--   NEW icd_codes          — the admin-managed diagnosis/ICD catalogue. Every
--                            row names its coding system AND version (ICD-10,
--                            ICD-10-CM and ICD-11 are not interchangeable), so a
--                            code is only unique within (system, version). No
--                            codes are seeded: the catalogue is entered or
--                            imported by an administrator from a verified
--                            source.
--   clinical_entries      + icd_code_id (the catalogue row a diagnosis was
--                            picked from) and a SNAPSHOT of what was picked —
--                            code_system, code_version, code_description — so
--                            the record stays historically accurate even if the
--                            catalogue row is later edited or deactivated. The
--                            existing `code` column keeps holding the code.
--   prescriptions         + clinical_snapshot (JSON) — the Patient Workbench
--                            information (patient, consultation, vitals,
--                            complaints, examinations, diagnoses, follow-up) the
--                            prescription was written from. Frozen with the
--                            prescription when it is finalized.
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureClinicalCoding.js
-- on every boot.
-- ============================================================================

-- ── ICD code master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS icd_codes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coding_system   VARCHAR(20)     NOT NULL,
  system_version  VARCHAR(30)     NOT NULL,
  code            VARCHAR(20)     NOT NULL,
  title           VARCHAR(255)    NOT NULL,
  description     VARCHAR(1000)   NULL,
  category        VARCHAR(150)    NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED NULL,
  updated_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_icd_system_code (coding_system, system_version, code),
  KEY idx_icd_title (title),
  KEY idx_icd_active (is_active, coding_system, system_version),
  CONSTRAINT fk_icd_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_icd_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Coded diagnoses (each guarded, so re-running is a no-op) ────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'icd_code_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN icd_code_id BIGINT UNSIGNED NULL AFTER code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_system');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_system VARCHAR(20) NULL AFTER icd_code_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_version');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_version VARCHAR(30) NULL AFTER code_system', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_description');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_description VARCHAR(1000) NULL AFTER code_version', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND INDEX_NAME = 'idx_ce_icd');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD INDEX idx_ce_icd (icd_code_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND CONSTRAINT_NAME = 'fk_ce_icd');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD CONSTRAINT fk_ce_icd FOREIGN KEY (icd_code_id) REFERENCES icd_codes (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Prescription clinical snapshot ──────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescriptions' AND COLUMN_NAME = 'clinical_snapshot');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescriptions ADD COLUMN clinical_snapshot JSON NULL AFTER no_medication', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
