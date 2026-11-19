-- ============================================================================
-- 049 — Doctor portfolio: affiliations, fellowships, expertise + richer fields
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped; every new column is
-- NULLable (or has a default), so existing rows and existing clients keep
-- working unchanged.
--
--   doctor_profiles     + short_intro, career_summary          (About section)
--   doctor_experience   + location
--   doctor_education    + location
--   doctor_memberships  + membership_number, show_membership_number (private
--                         by default), valid_until_year, description
--   doctor_publications + authors, doi, abstract, category
--   doctor_gallery      + title, category, alt_text, taken_on
--
--   NEW doctor_affiliations — where the doctor practises now (and, when the
--                             doctor says so, where they used to).
--   NEW doctor_fellowships  — fellowships / advanced training.
--   NEW doctor_expertise    — clinical / scientific expertise, areas of
--                             expertise and professional interests, one row per
--                             entry. (Procedures reuse doctor_services.)
--
-- Applied by `npm run migrate` and, idempotently, by
-- db/ensureDoctorPortfolioSections.js on every dev boot.
-- ============================================================================

-- ── New columns on existing tables (each guarded, so re-running is a no-op) ──
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'short_intro');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN short_intro VARCHAR(500) NULL AFTER bio', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'career_summary');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN career_summary VARCHAR(2000) NULL AFTER short_intro', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_experience' AND COLUMN_NAME = 'location');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_experience ADD COLUMN location VARCHAR(150) NULL AFTER role_title', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_education' AND COLUMN_NAME = 'location');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_education ADD COLUMN location VARCHAR(150) NULL AFTER field_of_study', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_memberships' AND COLUMN_NAME = 'membership_number');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_memberships ADD COLUMN membership_number VARCHAR(100) NULL AFTER role_title', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_memberships' AND COLUMN_NAME = 'show_membership_number');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_memberships ADD COLUMN show_membership_number TINYINT(1) NOT NULL DEFAULT 0 AFTER membership_number', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_memberships' AND COLUMN_NAME = 'valid_until_year');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_memberships ADD COLUMN valid_until_year SMALLINT UNSIGNED NULL AFTER since_year', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_memberships' AND COLUMN_NAME = 'description');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_memberships ADD COLUMN description VARCHAR(500) NULL AFTER valid_until_year', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_publications' AND COLUMN_NAME = 'authors');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_publications ADD COLUMN authors VARCHAR(500) NULL AFTER title', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_publications' AND COLUMN_NAME = 'doi');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_publications ADD COLUMN doi VARCHAR(150) NULL AFTER url', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_publications' AND COLUMN_NAME = 'abstract');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_publications ADD COLUMN abstract VARCHAR(2000) NULL AFTER doi', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_publications' AND COLUMN_NAME = 'category');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_publications ADD COLUMN category VARCHAR(100) NULL AFTER abstract', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_gallery' AND COLUMN_NAME = 'title');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_gallery ADD COLUMN title VARCHAR(150) NULL AFTER image_url', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_gallery' AND COLUMN_NAME = 'category');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_gallery ADD COLUMN category VARCHAR(30) NULL AFTER caption', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_gallery' AND COLUMN_NAME = 'alt_text');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_gallery ADD COLUMN alt_text VARCHAR(255) NULL AFTER category', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_gallery' AND COLUMN_NAME = 'taken_on');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_gallery ADD COLUMN taken_on DATE NULL AFTER alt_text', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── New tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_affiliations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id     BIGINT UNSIGNED NOT NULL,
  organization  VARCHAR(200) NOT NULL,
  role_title    VARCHAR(150) NULL,
  department    VARCHAR(150) NULL,
  location      VARCHAR(255) NULL,
  start_year    SMALLINT UNSIGNED NULL,
  end_year      SMALLINT UNSIGNED NULL,
  is_current    TINYINT(1) NOT NULL DEFAULT 1,
  website       VARCHAR(300) NULL,
  phone         VARCHAR(20) NULL,
  display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_affiliation_doctor (doctor_id, display_order),
  CONSTRAINT fk_affiliation_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doctor_fellowships (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id      BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(200) NOT NULL,
  institution    VARCHAR(200) NOT NULL,
  specialty_area VARCHAR(150) NULL,
  location       VARCHAR(150) NULL,
  start_year     SMALLINT UNSIGNED NULL,
  end_year       SMALLINT UNSIGNED NULL,
  description    VARCHAR(1000) NULL,
  display_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_fellowship_doctor (doctor_id, display_order),
  CONSTRAINT fk_fellowship_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The case-insensitive collation makes the unique key reject "ECG" next to
-- "ecg" in the same category — the service checks first and answers 409; the
-- key is the backstop against two requests racing.
CREATE TABLE IF NOT EXISTS doctor_expertise (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id     BIGINT UNSIGNED NOT NULL,
  category      ENUM('clinical','scientific','area','interest') NOT NULL,
  name          VARCHAR(150) NOT NULL,
  description   VARCHAR(300) NULL,
  display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expertise_entry (doctor_id, category, name),
  KEY idx_expertise_doctor (doctor_id, category, display_order),
  CONSTRAINT fk_expertise_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
