-- ============================================================================
-- 015 — Prescription medicine duration UNIT
--
-- `duration_days` stayed a plain number and every surface rendered it as
-- "N day(s)", so a doctor prescribing "3 months" had to write 90 and the
-- patient read "90 days". This adds the unit alongside the count; the column
-- keeps its name (the number is still the count) and DEFAULTS to 'day', so
-- every existing row means exactly what it meant before.
--
-- Idempotent (guarded via information_schema) like 013/014.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'duration_unit');
SET @ddl := IF(@has = 0,
  "ALTER TABLE prescription_items ADD COLUMN duration_unit ENUM('day','week','month') NOT NULL DEFAULT 'day' AFTER duration_days",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
