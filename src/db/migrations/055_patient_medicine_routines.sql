-- ============================================================================
-- 055 — Patient medicine routines, dose tracking and reminder settings
--       (docs/medicine-management-31-10-2026)
--
-- Doctors already keep a personal list (`medicines`) and the platform keeps a
-- shared catalogue (`medicine_masters`). What was missing is the PATIENT side:
-- the medicines a patient is actually taking, on what schedule, and whether
-- each dose was taken. Kept apart on purpose:
--
--   medicine_masters / medicines   = what a medicine IS (reusable records)
--   patient_medicines              = one patient's routine for one medicine
--                                    (from a finalized prescription line, or
--                                    entered by the patient themselves)
--   medicine_dose_logs             = one scheduled dose occurrence + its status
--   medicine_dose_events           = append-only log of every dose action
--   patient_medicine_settings      = per-patient reminder preferences
--
-- Changes to EXISTING tables (all additive, nullable):
--   medicines        + generic_name, manufacturer, description, medicine_master_id
--   medicine_masters + created_by_role  (who first added it: doctor / provider / admin)
--
-- `patient_current_medications` (the self-declared "current medications" in
-- the health record) is NOT touched — it is history the doctor reads in the
-- EMR, not a reminder schedule.
--
-- ADDITIVE ONLY: new tables (IF NOT EXISTS) and nullable columns; no row is
-- rewritten or deleted. Idempotent. Applied by `npm run migrate` and, on every
-- dev boot, by db/ensurePatientMedicines.js.
-- ============================================================================

-- ── medicines (doctor's own list): descriptive fields + catalogue link ──────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'generic_name');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN generic_name VARCHAR(255) NULL AFTER name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'manufacturer');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN manufacturer VARCHAR(255) NULL AFTER default_timing', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'description');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN description TEXT NULL AFTER manufacturer', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'medicine_master_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER doctor_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND CONSTRAINT_NAME = 'fk_medicines_master');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD CONSTRAINT fk_medicines_master FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── medicine_masters: source tracking ───────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_masters' AND COLUMN_NAME = 'created_by_role');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicine_masters ADD COLUMN created_by_role VARCHAR(30) NULL AFTER created_by', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── patient_medicines ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_medicines (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id           BIGINT UNSIGNED NOT NULL,
  source               ENUM('prescription','patient') NOT NULL,
  prescription_id      BIGINT UNSIGNED NULL,
  prescription_item_id BIGINT UNSIGNED NULL,
  prescribed_by        BIGINT UNSIGNED NULL,
  medicine_master_id   BIGINT UNSIGNED NULL,
  medicine_name        VARCHAR(200) NOT NULL,
  generic_name         VARCHAR(255) NULL,
  strength             VARCHAR(100) NULL,
  dosage_form          VARCHAR(50) NULL,
  dose                 VARCHAR(100) NULL,
  frequency            VARCHAR(100) NULL,
  food_timing          ENUM('before_food','after_food','with_food','anytime') NULL,
  reminder_times       JSON NULL,
  days_of_week         JSON NULL,
  timezone             VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  start_date           DATE NOT NULL,
  duration_days        SMALLINT UNSIGNED NULL,
  end_date             DATE NULL,
  instructions         VARCHAR(500) NULL,
  prescribed_snapshot  JSON NULL,
  reminder_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  status               ENUM('active','paused','completed','cancelled') NOT NULL DEFAULT 'active',
  status_reason        VARCHAR(50) NULL,
  status_changed_at    DATETIME NULL,
  superseded_by_id     BIGINT UNSIGNED NULL,
  client_request_id    VARCHAR(64) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pm_rx_item (prescription_item_id),
  UNIQUE KEY uq_pm_client_request (patient_id, client_request_id),
  KEY idx_pm_patient_status (patient_id, status),
  KEY idx_pm_prescription (prescription_id),
  CONSTRAINT fk_pm_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pm_prescription FOREIGN KEY (prescription_id) REFERENCES prescriptions (id) ON DELETE SET NULL,
  CONSTRAINT fk_pm_rx_item FOREIGN KEY (prescription_item_id) REFERENCES prescription_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_pm_prescriber FOREIGN KEY (prescribed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_pm_master FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL,
  CONSTRAINT fk_pm_superseded FOREIGN KEY (superseded_by_id) REFERENCES patient_medicines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── medicine_dose_logs: one row per scheduled dose ──────────────────────────
-- scheduled_at / due_at are UTC. due_at = scheduled_at, moved forward by a snooze.
CREATE TABLE IF NOT EXISTS medicine_dose_logs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_medicine_id BIGINT UNSIGNED NOT NULL,
  patient_id          BIGINT UNSIGNED NOT NULL,
  scheduled_date      DATE NOT NULL,
  scheduled_time      CHAR(5) NOT NULL,
  scheduled_at        DATETIME NOT NULL,
  due_at              DATETIME NOT NULL,
  status              ENUM('pending','taken','skipped','snoozed','missed') NOT NULL DEFAULT 'pending',
  snooze_count        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  action_at           DATETIME NULL,
  action_source       VARCHAR(20) NULL,
  notified_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dose_slot (patient_medicine_id, scheduled_at),
  KEY idx_dose_patient_sched (patient_id, scheduled_at),
  KEY idx_dose_status_due (status, due_at),
  CONSTRAINT fk_dose_pm FOREIGN KEY (patient_medicine_id) REFERENCES patient_medicines (id) ON DELETE CASCADE,
  CONSTRAINT fk_dose_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── medicine_dose_events: append-only action log (audit) ────────────────────
CREATE TABLE IF NOT EXISTS medicine_dose_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dose_log_id    BIGINT UNSIGNED NOT NULL,
  patient_id     BIGINT UNSIGNED NOT NULL,
  action         ENUM('taken','skipped','snoozed','missed') NOT NULL,
  snooze_minutes TINYINT UNSIGNED NULL,
  acted_at       DATETIME NOT NULL,
  source         VARCHAR(20) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dose_event_dose (dose_log_id),
  KEY idx_dose_event_patient (patient_id, acted_at),
  CONSTRAINT fk_dose_event_dose FOREIGN KEY (dose_log_id) REFERENCES medicine_dose_logs (id) ON DELETE CASCADE,
  CONSTRAINT fk_dose_event_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── patient_medicine_settings: reminder preferences ─────────────────────────
CREATE TABLE IF NOT EXISTS patient_medicine_settings (
  patient_id             BIGINT UNSIGNED NOT NULL,
  privacy_mode           TINYINT(1) NOT NULL DEFAULT 0,
  web_reminders          TINYINT(1) NOT NULL DEFAULT 1,
  default_snooze_minutes TINYINT UNSIGNED NOT NULL DEFAULT 10,
  timezone               VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (patient_id),
  CONSTRAINT fk_pms_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
