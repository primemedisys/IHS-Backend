-- ============================================================================
-- 054 — Default prescribing instructions on the doctor's own medicine list
--
-- "My Medicines" kept only name / dosage form / strength, so every
-- prescription line needed its frequency and food direction re-entered. These
-- columns hold the doctor's DEFAULTS, copied onto a prescription line when the
-- medicine is picked (and freely changed there — a prescription line keeps its
-- own frequency / timing, so editing it never touches this row).
--
--   medicines
--     + default_frequency VARCHAR(100) NULL   e.g. "BD" (same values as prescription_items.frequency)
--     + default_timing    VARCHAR(20)  NULL   before_food | after_food | with_food | anytime
--
-- Treatment duration is deliberately NOT stored here: it is decided per patient.
--
-- ADDITIVE ONLY: two nullable columns; existing rows keep NULL and work as
-- before. Idempotent. Applied by `npm run migrate` and, on every dev boot, by
-- db/ensureDoctorMedicineDefaults.js.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'default_frequency');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN default_frequency VARCHAR(100) NULL AFTER strength', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'default_timing');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN default_timing VARCHAR(20) NULL AFTER default_frequency', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
