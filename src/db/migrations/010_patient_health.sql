-- ============================================================================
-- 010 — Patient health records  (docs/patient-health-records/)
--
-- The patient's self-recorded medical profile: the reserved sub-resources from
-- docs/dbstruct.md §2/§16 (allergies, conditions, current medications, uploaded
-- records) PLUS a NEW `patient_vitals` timeline that powers the record table.
-- Also adds emergency-contact + "no known" columns to patient_profiles.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS (the base schema in dbstruct.md may
-- already have created the §2/§16 tables) and information_schema-guarded column
-- adds (dev may already have them via the boot shim). Safe to re-run.
--
-- NO `USE <db>` — the migration runner already selects env.DB_NAME.
-- ============================================================================

-- ── Allergies lookup + patient junction (M:N) ───────────────────────────────
CREATE TABLE IF NOT EXISTS allergies (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_allergy_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patient_allergies (
    patient_id  BIGINT UNSIGNED NOT NULL,
    allergy_id  INT UNSIGNED NOT NULL,
    severity    ENUM('mild','moderate','severe') NULL,
    PRIMARY KEY (patient_id, allergy_id),
    CONSTRAINT fk_patalg_patient FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patalg_allergy FOREIGN KEY (allergy_id) REFERENCES allergies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Conditions lookup + patient junction (M:N) ──────────────────────────────
CREATE TABLE IF NOT EXISTS conditions (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_condition_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patient_conditions (
    patient_id     BIGINT UNSIGNED NOT NULL,
    condition_id   INT UNSIGNED NOT NULL,
    diagnosed_year SMALLINT UNSIGNED NULL,
    PRIMARY KEY (patient_id, condition_id),
    CONSTRAINT fk_patcond_patient   FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patcond_condition FOREIGN KEY (condition_id) REFERENCES conditions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Current medications (1:M) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_current_medications (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id    BIGINT UNSIGNED NOT NULL,
    medicine_name VARCHAR(200) NOT NULL,
    dosage        VARCHAR(100) NULL,
    frequency     VARCHAR(100) NULL,
    started_on    DATE NULL,
    notes         VARCHAR(255) NULL,
    CONSTRAINT fk_patmed_patient FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    KEY idx_patmed_patient (patient_id)
) ENGINE=InnoDB;

-- ── Uploaded records (1:M, FKs users.id) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS uploaded_records (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id   BIGINT UNSIGNED NOT NULL,
    file_url     VARCHAR(500) NOT NULL,
    file_type    ENUM('prescription','lab_report','other') NOT NULL DEFAULT 'prescription',
    record_date  DATE NULL,
    tag          VARCHAR(100) NULL,
    uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_uploadrec_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
    KEY idx_uploadrec_patient (patient_id)
) ENGINE=InnoDB;

-- ── Patient vitals timeline (1:M) — the record-table rows (NEW) ─────────────
CREATE TABLE IF NOT EXISTS patient_vitals (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id     BIGINT UNSIGNED NOT NULL,
    recorded_on    DATE NOT NULL,
    blood_pressure VARCHAR(20)       NULL,
    pulse_rate_bpm SMALLINT UNSIGNED NULL,
    weight_kg      DECIMAL(5,2)      NULL,
    height_cm      DECIMAL(5,2)      NULL,
    temperature_f  DECIMAL(4,1)      NULL,
    spo2_percent   TINYINT UNSIGNED  NULL,
    note           VARCHAR(255)      NULL,
    source         ENUM('patient','doctor') NOT NULL DEFAULT 'patient',
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_patvit_patient FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    KEY idx_patvit_patient_date (patient_id, recorded_on)
) ENGINE=InnoDB;

-- ── patient_profiles new columns (guarded — may pre-exist) ──────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='patient_profiles' AND column_name='emergency_contact_name');
SET @s := IF(@c=0, 'ALTER TABLE patient_profiles ADD COLUMN emergency_contact_name VARCHAR(150) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='patient_profiles' AND column_name='emergency_contact_phone');
SET @s := IF(@c=0, 'ALTER TABLE patient_profiles ADD COLUMN emergency_contact_phone VARCHAR(20) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='patient_profiles' AND column_name='no_known_allergies');
SET @s := IF(@c=0, 'ALTER TABLE patient_profiles ADD COLUMN no_known_allergies TINYINT(1) NOT NULL DEFAULT 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='patient_profiles' AND column_name='no_known_conditions');
SET @s := IF(@c=0, 'ALTER TABLE patient_profiles ADD COLUMN no_known_conditions TINYINT(1) NOT NULL DEFAULT 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── Seed the lookups (harmless if the base schema already seeded them) ───────
INSERT IGNORE INTO allergies (name) VALUES
  ('Penicillin'), ('Aspirin'), ('Ibuprofen'), ('Sulfa drugs'), ('Peanuts'),
  ('Tree nuts'), ('Shellfish'), ('Eggs'), ('Milk'), ('Soy'), ('Latex'),
  ('Dust'), ('Pollen'), ('Pet dander');

INSERT IGNORE INTO conditions (name) VALUES
  ('Diabetes'), ('Hypertension'), ('Asthma'), ('Thyroid disorder'),
  ('Heart disease'), ('Arthritis'), ('Migraine'), ('Depression'),
  ('Anxiety'), ('High cholesterol'), ('Kidney disease'), ('Liver disease'),
  ('COPD'), ('Epilepsy');
