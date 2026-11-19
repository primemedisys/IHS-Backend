-- ============================================================================
-- 020 — "No current medications" flag
--
-- One boolean on patient_profiles, completing the trio the Reported-history
-- form already had two thirds of: no_known_allergies, no_known_conditions and
-- now no_current_medications.
--
-- Why a flag rather than inferring it from an empty list: an empty medication
-- list and "I take nothing" are clinically different statements. The first
-- means nobody has asked; the second is an answer a doctor can rely on. The
-- allergies and conditions columns exist for exactly this reason — medications
-- was simply never given the same treatment.
--
-- DEFAULT 0 (false) so every existing profile keeps meaning "not answered",
-- which is what it currently means. No backfill: setting this true for every
-- patient with no medications would fabricate an answer none of them gave.
--
-- Idempotent (information_schema-guarded) like 013-019.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_profiles'
    AND COLUMN_NAME = 'no_current_medications');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_profiles
     ADD COLUMN no_current_medications TINYINT(1) NOT NULL DEFAULT 0
       AFTER no_known_conditions',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
