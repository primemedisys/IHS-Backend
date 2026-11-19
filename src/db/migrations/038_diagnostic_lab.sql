-- ============================================================================
-- 038 — Diagnostic Lab Center
--
-- Everything here is ADDITIVE. No column is dropped, no enum value is removed,
-- no row is deleted or rewritten.
--
--   1. users.role               += 'diagnostic_lab'   (a new provider type that
--                                  signs in through the provider portal)
--   2. uploaded_records.source  += 'diagnostic_lab'   (a lab's report is filed
--                                  into the patient's EXISTING medical records)
--   3. diagnostic_tests         — a lab's own catalogue (name / price / availability)
--   4. diagnostic_requests      — a patient shares a prescription with a lab;
--                                  the booking (preferred date) lives on the row
--   5. diagnostic_request_tests — the lab's per-test answer, the patient's
--                                  selection, and the link to the filed report
--
-- Diagnostic requests are deliberately NOT stored in prescription_requests:
-- that table's provider_type / status enums and item FK (medicine inventory)
-- are pharmacy-specific, and keeping the two apart is what guarantees a
-- pharmacy never receives a lab request and vice versa.
--
-- Idempotent (information_schema-guarded) like 013–037.
-- ============================================================================

-- ── 1. users.role ───────────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%diagnostic_lab%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. uploaded_records.source ──────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'source' AND COLUMN_TYPE LIKE '%diagnostic_lab%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE uploaded_records MODIFY COLUMN source
     ENUM('patient','doctor','clinic','admin','diagnostic_lab') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. diagnostic_tests ─────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'diagnostic_tests');
SET @ddl := IF(@has = 0,
  'CREATE TABLE diagnostic_tests (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     lab_id        BIGINT UNSIGNED NOT NULL,
     name          VARCHAR(150)    NOT NULL,
     description   VARCHAR(500)    NULL,
     price         DECIMAL(10,2)   NOT NULL,
     is_available  TINYINT(1)      NOT NULL DEFAULT 1,
     is_active     TINYINT(1)      NOT NULL DEFAULT 1,
     created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_dt_lab (lab_id, is_active),
     CONSTRAINT fk_dt_lab FOREIGN KEY (lab_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. diagnostic_requests ──────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'diagnostic_requests');
SET @ddl := IF(@has = 0,
  'CREATE TABLE diagnostic_requests (
     id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id            BIGINT UNSIGNED NOT NULL,
     lab_id                BIGINT UNSIGNED NOT NULL,
     file_url              VARCHAR(512)    NOT NULL,
     file_name             VARCHAR(255)    NULL,
     notes                 TEXT            NULL,
     status                ENUM(''pending'',''viewed'',''available'',''booking_requested'',''confirmed'',''test_completed'',''report_ready'',''rejected'') NOT NULL DEFAULT ''pending'',
     lab_note              VARCHAR(500)    NULL,
     preferred_date        DATE            NULL,
     booking_notes         VARCHAR(500)    NULL,
     responded_at          DATETIME        NULL,
     booking_requested_at  DATETIME        NULL,
     confirmed_at          DATETIME        NULL,
     completed_at          DATETIME        NULL,
     report_ready_at       DATETIME        NULL,
     created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_dr_patient (patient_id),
     KEY idx_dr_lab     (lab_id),
     KEY idx_dr_status  (status),
     CONSTRAINT fk_dr_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_dr_lab     FOREIGN KEY (lab_id)     REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. diagnostic_request_tests ─────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'diagnostic_request_tests');
SET @ddl := IF(@has = 0,
  'CREATE TABLE diagnostic_request_tests (
     id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     diagnostic_request_id  BIGINT UNSIGNED NOT NULL,
     diagnostic_test_id     BIGINT UNSIGNED NULL,
     test_name              VARCHAR(150)    NOT NULL,
     price                  DECIMAL(10,2)   NULL,
     status                 ENUM(''available'',''unavailable'') NOT NULL,
     reason                 VARCHAR(255)    NULL,
     is_selected            TINYINT(1)      NOT NULL DEFAULT 0,
     report_record_id       BIGINT UNSIGNED NULL,
     report_uploaded_at     DATETIME        NULL,
     created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_drt_request (diagnostic_request_id),
     KEY idx_drt_test    (diagnostic_test_id),
     KEY idx_drt_report  (report_record_id),
     CONSTRAINT fk_drt_request FOREIGN KEY (diagnostic_request_id) REFERENCES diagnostic_requests (id) ON DELETE CASCADE,
     CONSTRAINT fk_drt_test    FOREIGN KEY (diagnostic_test_id)    REFERENCES diagnostic_tests (id)    ON DELETE SET NULL,
     CONSTRAINT fk_drt_report  FOREIGN KEY (report_record_id)      REFERENCES uploaded_records (id)    ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
