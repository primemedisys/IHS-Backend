-- ============================================================================
-- 018 — Record provenance
--
-- Answers "who wrote this?" for every medical record, now that a THIRD kind of
-- author exists (the clinic portal). Two columns, added identically to five
-- tables so every record type reads the same way wherever it is displayed:
--
--   source              — 'patient' | 'doctor' | 'clinic'
--   recorded_by_user_id — the actual author, for the display name
--
-- `source` reuses the name already on patient_vitals rather than inventing a
-- parallel concept; the ENUM there is merely widened.
--
-- recorded_by_user_id is ON DELETE SET NULL, deliberately: deleting a clinic
-- account must NOT cascade-delete the medical records it wrote. The record
-- outlives its author and simply loses the attribution.
--
-- clinical_notes gets a BACKFILL (source='doctor', recorded_by = doctor_id) so
-- existing notes keep showing their doctor's name — without it, every note in
-- the system would render as authorless.
--
-- Idempotent (information_schema-guarded) like 013-017.
-- ============================================================================

-- ── patient_vitals ──────────────────────────────────────────────────────────
-- `source` already exists as ENUM('patient','doctor'); widen it in place. Every
-- existing row keeps its value.
SET @hasClinic := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'source'
    AND COLUMN_TYPE LIKE '%clinic%');
SET @ddl := IF(@hasClinic = 0,
  "ALTER TABLE patient_vitals MODIFY source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'recorded_by_user_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_vitals_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── uploaded_records ────────────────────────────────────────────────────────
-- No uploader column existed here at all before now.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE uploaded_records
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_uploaded_records_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── patient_allergies ───────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_allergies' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE patient_allergies
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_allergies_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── patient_conditions ──────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_conditions' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE patient_conditions
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_conditions_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── clinical_notes ──────────────────────────────────────────────────────────
-- doctor_id must become NULLABLE: a clinic-authored note has no doctor, and
-- doctor_id FKs doctor_profiles(user_id), which a clinic's users.id would fail.
-- The FK survives a MODIFY — MySQL permits NULL under a foreign key.
SET @isNullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_notes' AND COLUMN_NAME = 'doctor_id');
SET @ddl := IF(@isNullable = 'NO',
  'ALTER TABLE clinical_notes MODIFY doctor_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_notes' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE clinical_notes
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'doctor',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_clinical_notes_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- BACKFILL. Every pre-existing note was written by a doctor from a booking, so
-- the author IS doctor_id. Without this the serializer has no name to show and
-- four existing views would render "—" where a doctor's name used to be.
-- Idempotent: only touches rows not already attributed.
UPDATE clinical_notes
   SET recorded_by_user_id = doctor_id, source = 'doctor'
 WHERE recorded_by_user_id IS NULL AND doctor_id IS NOT NULL;
