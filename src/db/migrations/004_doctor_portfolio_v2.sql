-- ============================================================================
-- 004 — Doctor Portfolio v2 (docs/doctor-portfolio-v2/backend-plan.md §1)
--
-- Fleshes out the public portfolio: 5 new doctor_profiles columns (hero tagline,
-- gender, philosophy, public contact) + 7 new 1:M section tables (education,
-- experience, services, publications, memberships, gallery, faqs) + the M:N
-- insurance lookup/junction. Lifts the bodies verbatim from docs/dbstruct.md
-- §6, §6f–6m. Idempotent (guarded column adds via information_schema,
-- CREATE TABLE IF NOT EXISTS, INSERT IGNORE) so it's safe to re-run and safe
-- alongside a fresh base schema that already created these.
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
-- ============================================================================

-- ── 5 new columns on doctor_profiles (dbstruct.md §6), added idempotently ────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'headline');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN headline VARCHAR(160) NULL AFTER bio', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'gender');
SET @ddl := IF(@has = 0,
  "ALTER TABLE doctor_profiles ADD COLUMN gender ENUM('male','female','other') NULL AFTER headline", 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'practice_philosophy');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN practice_philosophy VARCHAR(1000) NULL AFTER gender', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'public_phone');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN public_phone VARCHAR(20) NULL AFTER practice_philosophy', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'public_email');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN public_email VARCHAR(190) NULL AFTER public_phone', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 6f. DOCTOR EDUCATION — (1:M) structured qualifications ───────────────────
CREATE TABLE IF NOT EXISTS doctor_education (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    degree        VARCHAR(150) NOT NULL,
    institution   VARCHAR(200) NOT NULL,
    field_of_study VARCHAR(150) NULL,
    year_from     SMALLINT UNSIGNED NULL,
    year_to       SMALLINT UNSIGNED NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_education_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_education_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6g. DOCTOR EXPERIENCE — (1:M) career timeline ────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_experience (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    organization  VARCHAR(200) NOT NULL,
    role_title    VARCHAR(150) NOT NULL,
    start_year    SMALLINT UNSIGNED NOT NULL,
    end_year      SMALLINT UNSIGNED NULL,
    is_current    TINYINT(1) NOT NULL DEFAULT 0,
    description   VARCHAR(500) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_experience_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_experience_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6h. DOCTOR SERVICES — (1:M) procedures / treatments offered ──────────────
CREATE TABLE IF NOT EXISTS doctor_services (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(150) NOT NULL,
    description   VARCHAR(500) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_service_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_service_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6i. DOCTOR PUBLICATIONS & RESEARCH — (1:M) ───────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_publications (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    title         VARCHAR(300) NOT NULL,
    publisher     VARCHAR(200) NULL,
    year          SMALLINT UNSIGNED NULL,
    url           VARCHAR(300) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_publication_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_publication_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6j. DOCTOR MEMBERSHIPS — (1:M) medical bodies / associations ─────────────
CREATE TABLE IF NOT EXISTS doctor_memberships (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    organization  VARCHAR(200) NOT NULL,
    role_title    VARCHAR(150) NULL,
    since_year    SMALLINT UNSIGNED NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_membership_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_membership_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6k. DOCTOR GALLERY — (1:M) clinic / practice photos ──────────────────────
CREATE TABLE IF NOT EXISTS doctor_gallery (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    image_url     VARCHAR(500) NOT NULL,
    caption       VARCHAR(255) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_gallery_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_gallery_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6l. DOCTOR FAQ — (1:M) common patient questions ──────────────────────────
CREATE TABLE IF NOT EXISTS doctor_faqs (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    question      VARCHAR(300) NOT NULL,
    answer        VARCHAR(1000) NOT NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_faq_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_faq_doctor (doctor_id)
) ENGINE=InnoDB;

-- ── 6m. INSURANCE lookup + doctor<->insurance junction (M:N) ─────────────────
CREATE TABLE IF NOT EXISTS insurances (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(150) NOT NULL,
    UNIQUE KEY uq_insurance_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_insurances (
    doctor_id     BIGINT UNSIGNED NOT NULL,
    insurance_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (doctor_id, insurance_id),
    CONSTRAINT fk_docins_doctor    FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docins_insurance FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- seed insurers (guarded by uq_insurance_name, so re-running is safe)
INSERT IGNORE INTO insurances (name) VALUES
  ('Star Health'), ('HDFC ERGO'), ('ICICI Lombard'), ('Niva Bupa'),
  ('LIC Health'), ('CGHS'), ('Ayushman Bharat (PM-JAY)'), ('Self-pay / No insurance');
