-- ============================================================================
-- 051 — Doctor EMR workspace (structured consultation records)
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped; every new column is
-- NULLable (or has a default), so existing rows and existing clients keep
-- working unchanged. No booking / registration / login table is touched — the
-- "encounter" is still the existing booking.
--
--   patient_vitals       + recorded_at (time of reading), booking_id (the visit
--                          it was taken in), bp_systolic, bp_diastolic,
--                          heart_rate_bpm, respiratory_rate, waist_cm, hip_cm,
--                          head_circumference_cm. The legacy blood_pressure
--                          string is still written ("120/80") so every older
--                          view keeps working. BMI and waist-hip ratio stay
--                          DERIVED (never stored), like BMI already was.
--   patient_follow_ups   + interval_value, interval_unit, home_care,
--                          service_name, service_quantity, comments
--   prescription_items   + quantity, priority, name_type (trade | generic)
--   prescriptions        + no_medication (doctor ticked "medication not needed")
--
--   NEW clinical_entries — one row per structured consultation entry: chief
--                          complaint, history, comorbidity, examination,
--                          diagnosis, investigation order, doctor's note.
--                          Never hard-deleted: a wrong entry is retired with
--                          status 'entered_in_error' + a reason, so the record
--                          history is preserved.
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureEmrWorkspace.js
-- on every dev boot.
-- ============================================================================

-- ── New columns on existing tables (each guarded, so re-running is a no-op) ──
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'recorded_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN recorded_at DATETIME NULL AFTER recorded_on', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'booking_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN booking_id BIGINT UNSIGNED NULL AFTER patient_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'bp_systolic');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN bp_systolic SMALLINT UNSIGNED NULL AFTER blood_pressure', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'bp_diastolic');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN bp_diastolic SMALLINT UNSIGNED NULL AFTER bp_systolic', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'heart_rate_bpm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN heart_rate_bpm SMALLINT UNSIGNED NULL AFTER pulse_rate_bpm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'respiratory_rate');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN respiratory_rate SMALLINT UNSIGNED NULL AFTER heart_rate_bpm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'waist_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN waist_cm DECIMAL(5,1) NULL AFTER height_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'hip_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN hip_cm DECIMAL(5,1) NULL AFTER waist_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'head_circumference_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN head_circumference_cm DECIMAL(5,1) NULL AFTER hip_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND INDEX_NAME = 'idx_pv_booking');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD INDEX idx_pv_booking (booking_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'interval_value');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN interval_value SMALLINT UNSIGNED NULL AFTER follow_up_on', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'interval_unit');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN interval_unit ENUM(''day'',''week'',''month'') NULL AFTER interval_value', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'home_care');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN home_care TINYINT(1) NOT NULL DEFAULT 0 AFTER interval_unit', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'service_name');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN service_name VARCHAR(150) NULL AFTER home_care', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'service_quantity');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN service_quantity SMALLINT UNSIGNED NULL AFTER service_name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'comments');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN comments VARCHAR(1000) NULL AFTER service_quantity', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'quantity');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN quantity SMALLINT UNSIGNED NULL AFTER duration_unit', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'priority');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN priority ENUM(''routine'',''urgent'',''stat'') NULL AFTER quantity', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'name_type');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN name_type ENUM(''trade'',''generic'') NULL AFTER priority', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescriptions' AND COLUMN_NAME = 'no_medication');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescriptions ADD COLUMN no_medication TINYINT(1) NOT NULL DEFAULT 0 AFTER follow_up_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Structured consultation entries ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_entries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id      BIGINT UNSIGNED NOT NULL,
  doctor_id       BIGINT UNSIGNED NULL,
  booking_id      BIGINT UNSIGNED NULL,
  kind            ENUM('complaint','history','comorbidity','examination','diagnosis','investigation','doctor_note') NOT NULL,
  category        VARCHAR(60)     NULL,
  title           VARCHAR(255)    NULL,
  code            VARCHAR(20)     NULL,
  details         JSON            NULL,
  remarks         TEXT            NULL,
  recorded_on     DATE            NULL,
  patient_visible TINYINT(1)      NOT NULL DEFAULT 1,
  status          ENUM('active','entered_in_error') NOT NULL DEFAULT 'active',
  retired_reason  VARCHAR(255)    NULL,
  created_by      BIGINT UNSIGNED NULL,
  updated_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ce_patient_kind (patient_id, kind, created_at),
  KEY idx_ce_booking (booking_id),
  KEY idx_ce_doctor (doctor_id, created_at),
  CONSTRAINT fk_ce_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ce_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
