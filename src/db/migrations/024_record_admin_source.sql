-- ============================================================================
-- 024 — Admin as a record author
--
-- Widens uploaded_records.source with 'admin' so the admin portal can file a
-- report on a patient's behalf under its own name, instead of masquerading as
-- a clinic or doctor. The provenance chip on every surface then tells the
-- truth about who uploaded the document.
--
-- Purely additive: every existing row keeps its value.
--
-- Idempotent (information_schema-guarded) like 013-023.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'source' AND COLUMN_TYPE NOT LIKE '%admin%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN source ENUM('patient','doctor','clinic','admin')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
