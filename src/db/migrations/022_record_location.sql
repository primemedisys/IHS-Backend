-- ============================================================================
-- 022 — Where an uploaded record was produced
--
-- One nullable column on uploaded_records, mirroring patient_vitals.location
-- (migration for vitals) so "where did this happen" is asked the same way
-- everywhere in the record.
--
-- Nullable with no backfill: every existing row genuinely has no known
-- location, and inventing one would be fabricating clinical provenance.
--
-- Idempotent (information_schema-guarded) like 013-021.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'location');
SET @ddl := IF(@has = 0,
  'ALTER TABLE uploaded_records ADD COLUMN location VARCHAR(150) NULL AFTER tag',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
