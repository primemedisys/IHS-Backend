-- ============================================================================
-- 060 — ICD & Diagnosis Master: Excel import audit trail
--
-- ADDITIVE ONLY. One new table; no existing table, column or row is touched.
--
--   NEW icd_import_batches — one row per confirmed Excel import into the
--                            icd_codes master (migration 059): who imported
--                            which file (name + SHA-256), into which version,
--                            with which duplicate policy, and what happened
--                            (inserted / updated / skipped / invalid counts,
--                            plus a capped sample of the rejected rows). A
--                            failed import is recorded too, with nothing
--                            written to icd_codes (the import is one
--                            transaction).
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureIcdImportBatches.js
-- on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS icd_import_batches (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_name           VARCHAR(255)    NOT NULL,
  file_sha256         CHAR(64)        NOT NULL,
  system_version      VARCHAR(30)     NOT NULL,
  duplicate_policy    VARCHAR(10)     NOT NULL DEFAULT 'skip',
  status              VARCHAR(12)     NOT NULL,
  total_rows          INT UNSIGNED    NOT NULL DEFAULT 0,
  valid_rows          INT UNSIGNED    NOT NULL DEFAULT 0,
  invalid_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  duplicate_file_rows INT UNSIGNED    NOT NULL DEFAULT 0,
  existing_rows       INT UNSIGNED    NOT NULL DEFAULT 0,
  inserted_rows       INT UNSIGNED    NOT NULL DEFAULT 0,
  updated_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  systems             JSON            NULL,
  error_sample        JSON            NULL,
  failure_reason      VARCHAR(255)    NULL,
  imported_by         BIGINT UNSIGNED NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iib_created (created_at),
  CONSTRAINT fk_iib_user FOREIGN KEY (imported_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
