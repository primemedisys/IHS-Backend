-- ============================================================================
-- 053 — Structured medicine details on prescription lines
--
-- A prescription line kept the medicine as one printed label ("Pan 40 40 mg")
-- and had nowhere to keep the catalogue's dosage form, so the editor reused
-- the free-text `dosage` for strength, mixing a medicine's STRENGTH up with
-- the DOSE the doctor prescribes. These columns keep them apart.
--
--   prescription_items
--     + strength           VARCHAR(100) NULL  strength of the chosen medicine
--     + dosage_form        VARCHAR(50)  NULL  tablet / capsule / syrup / … (MEDICINE_TYPES)
--     + medicine_master_id BIGINT UNSIGNED NULL  the IHS catalogue row it came from
--                                              (FK, ON DELETE SET NULL)
--   medicines (the doctor's own list)
--     + dosage_form        VARCHAR(50)  NULL  same vocabulary as the catalogue
--
-- `medicine_name` stays the printed label, so every existing reader (PDF,
-- patient views, pharmacy sharing) keeps working unchanged.
--
-- ADDITIVE ONLY: nullable columns + an index/FK; no row is rewritten.
-- Idempotent (each step checks information_schema). Applied by
-- `npm run migrate` and, on every dev boot, by db/ensureRxItemDetails.js.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'strength');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN strength VARCHAR(100) NULL AFTER medicine_name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'dosage_form');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN dosage_form VARCHAR(50) NULL AFTER strength', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'medicine_master_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER medicine_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND CONSTRAINT_NAME = 'fk_rxitem_medicine_master');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD CONSTRAINT fk_rxitem_medicine_master FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'dosage_form');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN dosage_form VARCHAR(50) NULL AFTER form', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
