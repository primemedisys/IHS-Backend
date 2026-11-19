-- ============================================================================
-- 002 — Doctor Registration & Portfolio (docs/doctor-onboarding/backend-plan.md §1)
--
-- Creates the portfolio tables + two new doctor_profiles columns and seeds the
-- specialization/language lookups. Idempotent (CREATE TABLE IF NOT EXISTS,
-- guarded column adds, INSERT IGNORE) so it's safe to re-run and safe alongside
-- the dev-time sequelize.sync() that may have already created these tables.
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME), so this file is database-name agnostic.
-- Assumes the base tables (users, doctor_profiles) already exist — in dev they
-- are created by sequelize.sync(); in prod by docs/dbstruct.md.
-- ============================================================================

-- ── one new column: draft vs submitted (README §3), added idempotently ──────
SET @has_is_submitted := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'is_submitted'
);
SET @ddl := IF(@has_is_submitted = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN is_submitted TINYINT(1) NOT NULL DEFAULT 0 AFTER verification_status',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- verification_notes exists in dbstruct.md but not in the sync()'d model — add
-- it if missing so the admin reject flow can persist a reason.
SET @has_notes := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'verification_notes'
);
SET @ddl := IF(@has_notes = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN verification_notes VARCHAR(500) NULL AFTER is_submitted',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── lookups (dbstruct.md §4, §5) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS specializations (
    id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name   VARCHAR(120) NOT NULL,
    slug   VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_spec_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS languages (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(60) NOT NULL,
    UNIQUE KEY uq_language_name (name)
) ENGINE=InnoDB;

-- ── M:N junctions (dbstruct.md §6d, §6e) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_specializations (
    doctor_id          BIGINT UNSIGNED NOT NULL,
    specialization_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (doctor_id, specialization_id),
    CONSTRAINT fk_docspec_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docspec_spec   FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_languages (
    doctor_id    BIGINT UNSIGNED NOT NULL,
    language_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (doctor_id, language_id),
    CONSTRAINT fk_doclang_doctor   FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_doclang_language FOREIGN KEY (language_id) REFERENCES languages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 1:M portfolio + documents (dbstruct.md §6b, §6c, §7, §18b) ──────────────
CREATE TABLE IF NOT EXISTS doctor_awards (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    title        VARCHAR(255) NOT NULL,
    description  VARCHAR(500) NULL,
    award_year   SMALLINT UNSIGNED NULL,
    CONSTRAINT fk_award_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_award_doctor (doctor_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_links (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    link_type    ENUM('website','linkedin','instagram','youtube','other') NOT NULL,
    url          VARCHAR(300) NOT NULL,
    CONSTRAINT fk_link_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_link_doctor (doctor_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_documents (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    doc_type     ENUM('degree_certificate','id_proof','council_registration','other') NOT NULL,
    file_url     VARCHAR(500) NOT NULL,
    uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_docdoc_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_docdoc_doctor (doctor_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_search_keywords (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    keyword      VARCHAR(150) NOT NULL,
    weight       TINYINT UNSIGNED NOT NULL DEFAULT 1,
    is_approved  TINYINT(1) NOT NULL DEFAULT 1,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_doctorkeyword_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    UNIQUE KEY uq_doctor_keyword (doctor_id, keyword),
    KEY idx_doctorkeyword_keyword (keyword)
) ENGINE=InnoDB;

-- ── seed the lookups (dbstruct.md §SEED); re-run safe via the UNIQUE keys ────
INSERT IGNORE INTO specializations (name, slug) VALUES
  ('Cardiologist', 'cardiologist'),
  ('Dermatologist', 'dermatologist'),
  ('General Physician', 'general-physician'),
  ('Pediatrician', 'pediatrician'),
  ('Orthopedic', 'orthopedic'),
  ('ENT Specialist', 'ent-specialist'),
  ('Gynecologist', 'gynecologist'),
  ('Psychiatrist', 'psychiatrist');

INSERT IGNORE INTO languages (name) VALUES
  ('English'), ('Hindi'), ('Odia'), ('Bengali'), ('Telugu');
