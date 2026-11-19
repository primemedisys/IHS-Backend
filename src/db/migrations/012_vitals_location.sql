-- ============================================================================
-- 012 — Vitals reading location  (docs/vitals-record-table/)
--
-- Adds `patient_vitals.location`: the free-text place a reading was taken
-- ("Home", "Apollo Clinic"), shown as the Location column of the record table.
--
-- Idempotent: information_schema-guarded column add (dev may already have it via
-- the boot shim db/ensureVitalsLocation.js). Safe to re-run.
--
-- NO `USE <db>` — the migration runner already selects env.DB_NAME.
-- ============================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'patient_vitals'
               AND column_name = 'location');
SET @s := IF(@c = 0,
  'ALTER TABLE patient_vitals ADD COLUMN location VARCHAR(150) NULL AFTER note',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
