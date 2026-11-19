-- ============================================================================
-- 021 — Record types: x-ray and MRI
--
-- Widens uploaded_records.file_type from 3 values to 5. The doctor's record
-- view groups a patient's documents into Prescription | Report | X-ray | MRI;
-- until now only the first two existed, so scans were inferred from the free
-- text label and a scan named anything else was silently filed as a report.
--
-- Purely additive: every existing row keeps its value, and 'other' stays for
-- anything that fits none of the four. No backfill — re-categorising existing
-- rows would guess at what a patient meant.
--
-- Idempotent (information_schema-guarded) like 013-020.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'file_type' AND COLUMN_TYPE NOT LIKE '%xray%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN file_type ENUM('prescription','lab_report','xray','mri','other')
     NOT NULL DEFAULT 'prescription'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
