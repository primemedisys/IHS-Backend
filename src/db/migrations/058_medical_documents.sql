-- ============================================================================
-- 058 — Medical documents (patient website: Medical History → Medical Documents)
--
-- Reuses uploaded_records — the one table every patient document already
-- lives in — instead of adding a second document table:
--
--   * file_type gains 'identity' (Aadhaar, ABHA, other photo ID, insurance and
--     health-scheme cards). These rows are the patient's own: the model's
--     default scope hides them from every doctor, clinic, lab and admin read.
--   * document_kind  — the finer document type the patient picked (CT scan,
--     discharge summary, …). file_type stays the broad, consent-relevant class.
--   * doctor_name    — the (possibly external) doctor named on the document.
--   * description    — the patient's notes.
--   * id_last4       — ONLY the last four digits of an ID / policy number. A
--     full Aadhaar number is never stored (Aadhaar Act s.29; UIDAI masking).
--   * original_name / mime_type / file_size — what was uploaded, for display.
--   * updated_at     — last metadata edit or file replacement (audit).
--
-- Purely additive: no existing row changes, no backfill. Idempotent
-- (information_schema-guarded), like 021/022. Boot guard: ensureMedicalDocuments.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'file_type' AND COLUMN_TYPE NOT LIKE '%identity%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN file_type ENUM('prescription','lab_report','xray','mri','other','identity')
     NOT NULL DEFAULT 'prescription'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'document_kind');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN document_kind VARCHAR(40) NULL AFTER file_type', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'doctor_name');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN doctor_name VARCHAR(120) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'description');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN description VARCHAR(1000) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'id_last4');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN id_last4 CHAR(4) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'original_name');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN original_name VARCHAR(255) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'mime_type');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN mime_type VARCHAR(120) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'file_size');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN file_size INT UNSIGNED NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'updated_at');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
