-- ============================================================================
-- 039 — Blood Bank / Blood Centre
--
-- Everything here is ADDITIVE: one enum value is added to users.role and new
-- blood_* tables are created. No existing column, row or table is changed.
--
-- Reused, not duplicated: users (accounts, the bank's Google location
-- columns from migration 034), medicine_notifications (in-app notifications),
-- the storage driver (supporting documents are stored as URLs, streamed).
--
-- Not created on purpose:
--   * blood_inventory  — inventory is DERIVED from blood_units (GROUP BY), so
--                        it can never drift from the units actually held;
--   * blood_components — components are configuration (config/bloodBank.js),
--                        stored as VARCHAR so adding one needs no migration;
--   * blood_request_items — one request = one blood group + component + count;
--   * blood_center_staff  — no provider module has staff sub-accounts; actions
--                        record the account (users.id) plus the staff name typed.
--   * donor_deferrals  — a deferral is a screening DECISION (+ reason/until),
--                        recorded on blood_donor_screenings.
--
-- Every CREATE is IF NOT EXISTS, so this file is idempotent on its own and is
-- also executed statement-by-statement by db/ensureBloodBank.js on boot.
-- ============================================================================

-- ── users.role += 'blood_bank' ──────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%blood_bank%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab','blood_bank')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS blood_bank_profiles (
  user_id              BIGINT UNSIGNED NOT NULL,
  centre_name          VARCHAR(150)    NOT NULL,
  centre_type          ENUM('hospital_based','standalone','government','charitable') NOT NULL DEFAULT 'standalone',
  license_number       VARCHAR(100)    NULL,
  license_valid_until  DATE            NULL,
  contact_person       VARCHAR(150)    NULL,
  phone                VARCHAR(20)     NULL,
  emergency_phone      VARCHAR(20)     NULL,
  district             VARCHAR(100)    NULL,
  operating_hours      VARCHAR(150)    NULL,
  is_24x7              TINYINT(1)      NOT NULL DEFAULT 0,
  components_offered   JSON            NULL,
  about                VARCHAR(1000)   NULL,
  verification_status  ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  verification_notes   VARCHAR(500)    NULL,
  verified_at          DATETIME        NULL,
  is_active            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_bbp_verification (verification_status, is_active),
  CONSTRAINT fk_bbp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Gapless per-year reference numbers (DON-2026-000001 …), same technique as rx_counters.
CREATE TABLE IF NOT EXISTS blood_counters (
  kind      VARCHAR(10)       NOT NULL,
  year      SMALLINT UNSIGNED NOT NULL,
  next_val  INT UNSIGNED      NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_donors (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  donor_code        VARCHAR(20)     NOT NULL,
  patient_user_id   BIGINT UNSIGNED NULL,
  name              VARCHAR(150)    NOT NULL,
  date_of_birth     DATE            NULL,
  gender            ENUM('male','female','other') NULL,
  phone             VARCHAR(20)     NOT NULL,
  email             VARCHAR(190)    NULL,
  address_line      VARCHAR(255)    NULL,
  city              VARCHAR(100)    NULL,
  state             VARCHAR(100)    NULL,
  pincode           VARCHAR(20)     NULL,
  blood_group       ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NULL,
  status            ENUM('active','deferred_temporary','deferred_permanent','inactive') NOT NULL DEFAULT 'active',
  deferred_until    DATE            NULL,
  last_donation_at  DATETIME        NULL,
  donation_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  consent_given     TINYINT(1)      NOT NULL DEFAULT 0,
  consent_at        DATETIME        NULL,
  notes             VARCHAR(1000)   NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bd_code (donor_code),
  KEY idx_bd_bank (blood_bank_id, status),
  KEY idx_bd_bank_phone (blood_bank_id, phone),
  KEY idx_bd_patient (patient_user_id),
  CONSTRAINT fk_bd_bank    FOREIGN KEY (blood_bank_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bd_patient FOREIGN KEY (patient_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_donor_screenings (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id       BIGINT UNSIGNED NOT NULL,
  donor_id            BIGINT UNSIGNED NOT NULL,
  screened_at         DATETIME        NOT NULL,
  weight_kg           DECIMAL(5,1)    NULL,
  hemoglobin_gdl      DECIMAL(4,1)    NULL,
  bp_systolic         SMALLINT UNSIGNED NULL,
  bp_diastolic        SMALLINT UNSIGNED NULL,
  pulse_bpm           SMALLINT UNSIGNED NULL,
  temperature_c       DECIMAL(4,1)    NULL,
  questionnaire_cleared TINYINT(1)    NULL,
  decision            ENUM('eligible','deferred_temporary','deferred_permanent') NOT NULL,
  deferral_reason     VARCHAR(255)    NULL,
  deferred_until      DATE            NULL,
  screened_by_name    VARCHAR(150)    NOT NULL,
  notes               VARCHAR(1000)   NULL,
  recorded_by         BIGINT UNSIGNED NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bds_donor (donor_id, screened_at),
  KEY idx_bds_bank (blood_bank_id),
  CONSTRAINT fk_bds_bank  FOREIGN KEY (blood_bank_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bds_donor FOREIGN KEY (donor_id)      REFERENCES blood_donors (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_camps (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id   BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(150)    NOT NULL,
  camp_date       DATE            NOT NULL,
  start_time      TIME            NOT NULL,
  end_time        TIME            NOT NULL,
  venue           VARCHAR(255)    NOT NULL,
  city            VARCHAR(100)    NULL,
  state           VARCHAR(100)    NULL,
  organizer       VARCHAR(150)    NULL,
  contact_phone   VARCHAR(20)     NULL,
  description     VARCHAR(1000)   NULL,
  capacity        INT UNSIGNED    NULL,
  status          ENUM('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bc_bank (blood_bank_id, camp_date),
  KEY idx_bc_date (camp_date, status),
  CONSTRAINT fk_bc_bank FOREIGN KEY (blood_bank_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_camp_registrations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  camp_id       BIGINT UNSIGNED NOT NULL,
  patient_id    BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(150)    NOT NULL,
  phone         VARCHAR(20)     NULL,
  blood_group   ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NULL,
  status        ENUM('registered','cancelled','attended') NOT NULL DEFAULT 'registered',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bcr_camp_patient (camp_id, patient_id),
  KEY idx_bcr_patient (patient_id),
  CONSTRAINT fk_bcr_camp    FOREIGN KEY (camp_id)    REFERENCES blood_camps (id) ON DELETE CASCADE,
  CONSTRAINT fk_bcr_patient FOREIGN KEY (patient_id) REFERENCES users (id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_donations (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donation_code     VARCHAR(20)     NOT NULL,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  donor_id          BIGINT UNSIGNED NOT NULL,
  screening_id      BIGINT UNSIGNED NOT NULL,
  camp_id           BIGINT UNSIGNED NULL,
  collected_at      DATETIME        NOT NULL,
  volume_ml         SMALLINT UNSIGNED NOT NULL,
  bag_type          VARCHAR(50)     NULL,
  collected_by_name VARCHAR(150)    NOT NULL,
  status            ENUM('collected','processed','discarded') NOT NULL DEFAULT 'collected',
  testing_status    ENUM('pending','passed','failed') NOT NULL DEFAULT 'pending',
  testing_decided_by_name VARCHAR(150) NULL,
  testing_decided_at DATETIME       NULL,
  notes             VARCHAR(1000)   NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bdn_code (donation_code),
  UNIQUE KEY uq_bdn_screening (screening_id),
  KEY idx_bdn_bank (blood_bank_id, collected_at),
  KEY idx_bdn_donor (donor_id),
  CONSTRAINT fk_bdn_bank      FOREIGN KEY (blood_bank_id) REFERENCES users (id)                  ON DELETE CASCADE,
  CONSTRAINT fk_bdn_donor     FOREIGN KEY (donor_id)      REFERENCES blood_donors (id)           ON DELETE CASCADE,
  CONSTRAINT fk_bdn_screening FOREIGN KEY (screening_id)  REFERENCES blood_donor_screenings (id) ON DELETE CASCADE,
  CONSTRAINT fk_bdn_camp      FOREIGN KEY (camp_id)       REFERENCES blood_camps (id)            ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_tests (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  donation_id       BIGINT UNSIGNED NOT NULL,
  test_name         VARCHAR(100)    NOT NULL,
  result            ENUM('non_reactive','reactive','indeterminate','recorded') NOT NULL,
  result_value      VARCHAR(100)    NULL,
  method            VARCHAR(100)    NULL,
  tested_at         DATETIME        NOT NULL,
  performed_by_name VARCHAR(150)    NOT NULL,
  notes             VARCHAR(500)    NULL,
  recorded_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bt_donation (donation_id),
  KEY idx_bt_bank (blood_bank_id, tested_at),
  CONSTRAINT fk_bt_bank     FOREIGN KEY (blood_bank_id) REFERENCES users (id)           ON DELETE CASCADE,
  CONSTRAINT fk_bt_donation FOREIGN KEY (donation_id)   REFERENCES blood_donations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_units (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  unit_code         VARCHAR(20)     NOT NULL,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  donation_id       BIGINT UNSIGNED NOT NULL,
  donor_id          BIGINT UNSIGNED NOT NULL,
  parent_unit_id    BIGINT UNSIGNED NULL,
  blood_group       ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  component         VARCHAR(30)     NOT NULL,
  volume_ml         SMALLINT UNSIGNED NULL,
  collected_at      DATETIME        NOT NULL,
  processed_at      DATETIME        NULL,
  expires_at        DATETIME        NOT NULL,
  testing_status    ENUM('pending','passed','failed') NOT NULL DEFAULT 'pending',
  status            ENUM('quarantine','testing','available','reserved','issued','transferred','processed','discarded','expired') NOT NULL DEFAULT 'quarantine',
  storage_location  VARCHAR(100)    NULL,
  released_by_name  VARCHAR(150)    NULL,
  released_at       DATETIME        NULL,
  discard_reason    VARCHAR(255)    NULL,
  discarded_at      DATETIME        NULL,
  created_by        BIGINT UNSIGNED NULL,
  updated_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bu_code (unit_code),
  KEY idx_bu_inventory (blood_bank_id, status, blood_group, component),
  KEY idx_bu_expiry (blood_bank_id, status, expires_at),
  KEY idx_bu_donation (donation_id),
  KEY idx_bu_parent (parent_unit_id),
  CONSTRAINT fk_bu_bank     FOREIGN KEY (blood_bank_id)  REFERENCES users (id)           ON DELETE CASCADE,
  CONSTRAINT fk_bu_donation FOREIGN KEY (donation_id)    REFERENCES blood_donations (id) ON DELETE CASCADE,
  CONSTRAINT fk_bu_donor    FOREIGN KEY (donor_id)       REFERENCES blood_donors (id)    ON DELETE CASCADE,
  CONSTRAINT fk_bu_parent   FOREIGN KEY (parent_unit_id) REFERENCES blood_units (id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_requests (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_code          VARCHAR(20)     NOT NULL,
  patient_id            BIGINT UNSIGNED NOT NULL,
  blood_bank_id         BIGINT UNSIGNED NOT NULL,
  referred_by_doctor_id BIGINT UNSIGNED NULL,
  blood_group           ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  component             VARCHAR(30)     NOT NULL,
  units_required        SMALLINT UNSIGNED NOT NULL,
  urgency               ENUM('routine','urgent','emergency') NOT NULL DEFAULT 'routine',
  is_emergency          TINYINT(1)      NOT NULL DEFAULT 0,
  required_by           DATETIME        NULL,
  patient_name          VARCHAR(150)    NOT NULL,
  hospital_name         VARCHAR(200)    NOT NULL,
  hospital_address      VARCHAR(255)    NULL,
  doctor_name           VARCHAR(150)    NULL,
  contact_name          VARCHAR(150)    NOT NULL,
  contact_phone         VARCHAR(20)     NOT NULL,
  city                  VARCHAR(100)    NULL,
  state                 VARCHAR(100)    NULL,
  notes                 VARCHAR(1000)   NULL,
  document_url          VARCHAR(512)    NULL,
  document_name         VARCHAR(255)    NULL,
  status                ENUM('pending','viewed','processing','available','reserved','approved','rejected','completed','cancelled') NOT NULL DEFAULT 'pending',
  bank_note             VARCHAR(500)    NULL,
  approved_by_name      VARCHAR(150)    NULL,
  approved_at           DATETIME        NULL,
  completed_at          DATETIME        NULL,
  cancelled_at          DATETIME        NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_brq_code (request_code),
  KEY idx_brq_patient (patient_id, created_at),
  KEY idx_brq_bank (blood_bank_id, status, is_emergency),
  CONSTRAINT fk_brq_patient FOREIGN KEY (patient_id)            REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_brq_bank    FOREIGN KEY (blood_bank_id)         REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_brq_doctor  FOREIGN KEY (referred_by_doctor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_reservations (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  request_id        BIGINT UNSIGNED NOT NULL,
  unit_id           BIGINT UNSIGNED NOT NULL,
  status            ENUM('active','released','issued') NOT NULL DEFAULT 'active',
  reserved_by_name  VARCHAR(150)    NOT NULL,
  reserved_at       DATETIME        NOT NULL,
  released_at       DATETIME        NULL,
  release_reason    VARCHAR(255)    NULL,
  recorded_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_brs_request (request_id, status),
  KEY idx_brs_unit (unit_id, status),
  KEY idx_brs_bank (blood_bank_id, status),
  CONSTRAINT fk_brs_bank    FOREIGN KEY (blood_bank_id) REFERENCES users (id)          ON DELETE CASCADE,
  CONSTRAINT fk_brs_request FOREIGN KEY (request_id)    REFERENCES blood_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_brs_unit    FOREIGN KEY (unit_id)       REFERENCES blood_units (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_crossmatches (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  request_id        BIGINT UNSIGNED NOT NULL,
  unit_id           BIGINT UNSIGNED NOT NULL,
  reservation_id    BIGINT UNSIGNED NULL,
  result            ENUM('compatible','incompatible') NOT NULL,
  method            VARCHAR(100)    NULL,
  performed_at      DATETIME        NOT NULL,
  performed_by_name VARCHAR(150)    NOT NULL,
  notes             VARCHAR(500)    NULL,
  recorded_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bcm_request (request_id),
  KEY idx_bcm_unit (unit_id),
  KEY idx_bcm_bank (blood_bank_id, performed_at),
  CONSTRAINT fk_bcm_bank        FOREIGN KEY (blood_bank_id)  REFERENCES users (id)              ON DELETE CASCADE,
  CONSTRAINT fk_bcm_request     FOREIGN KEY (request_id)     REFERENCES blood_requests (id)     ON DELETE CASCADE,
  CONSTRAINT fk_bcm_unit        FOREIGN KEY (unit_id)        REFERENCES blood_units (id)        ON DELETE CASCADE,
  CONSTRAINT fk_bcm_reservation FOREIGN KEY (reservation_id) REFERENCES blood_reservations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_issues (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_code        VARCHAR(20)     NOT NULL,
  blood_bank_id     BIGINT UNSIGNED NOT NULL,
  request_id        BIGINT UNSIGNED NOT NULL,
  unit_id           BIGINT UNSIGNED NOT NULL,
  reservation_id    BIGINT UNSIGNED NOT NULL,
  crossmatch_id     BIGINT UNSIGNED NOT NULL,
  issued_to_name    VARCHAR(150)    NOT NULL,
  hospital_name     VARCHAR(200)    NOT NULL,
  issued_by_name    VARCHAR(150)    NOT NULL,
  verified_by_name  VARCHAR(150)    NOT NULL,
  issued_at         DATETIME        NOT NULL,
  notes             VARCHAR(500)    NULL,
  recorded_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bis_code (issue_code),
  UNIQUE KEY uq_bis_unit (unit_id),
  KEY idx_bis_request (request_id),
  KEY idx_bis_bank (blood_bank_id, issued_at),
  CONSTRAINT fk_bis_bank        FOREIGN KEY (blood_bank_id)  REFERENCES users (id)              ON DELETE CASCADE,
  CONSTRAINT fk_bis_request     FOREIGN KEY (request_id)     REFERENCES blood_requests (id)     ON DELETE CASCADE,
  CONSTRAINT fk_bis_unit        FOREIGN KEY (unit_id)        REFERENCES blood_units (id)        ON DELETE CASCADE,
  CONSTRAINT fk_bis_reservation FOREIGN KEY (reservation_id) REFERENCES blood_reservations (id) ON DELETE CASCADE,
  CONSTRAINT fk_bis_crossmatch  FOREIGN KEY (crossmatch_id)  REFERENCES blood_crossmatches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blood_audit_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id   BIGINT UNSIGNED NOT NULL,
  actor_user_id   BIGINT UNSIGNED NULL,
  entity_type     VARCHAR(30)     NOT NULL,
  entity_id       BIGINT UNSIGNED NOT NULL,
  action          VARCHAR(50)     NOT NULL,
  from_status     VARCHAR(30)     NULL,
  to_status       VARCHAR(30)     NULL,
  details         JSON            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bal_bank (blood_bank_id, created_at),
  KEY idx_bal_entity (entity_type, entity_id),
  CONSTRAINT fk_bal_bank  FOREIGN KEY (blood_bank_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bal_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
