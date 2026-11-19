-- ============================================================================
-- 048 — Award images + doctor-managed patient testimonials
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped:
--   1. doctor_awards gains two OPTIONAL columns: `issuer` (issuing
--      organisation) and `image_url` (an uploaded certificate / award photo).
--      Existing text-only awards keep working with both NULL.
--   2. New table doctor_testimonials: feedback the DOCTOR enters and manages
--      for their public portfolio (patients do not publish through it). Only
--      rows with is_visible = 1 are shown publicly; the portfolio labels them
--      "shared by the doctor", never "verified". patient_photo_url is set only
--      after the doctor confirms the patient's consent (enforced by the API).
--
-- Applied by `npm run migrate` and, idempotently, by
-- db/ensureDoctorAwardsTestimonials.js on every dev boot.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_awards' AND COLUMN_NAME = 'issuer');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_awards ADD COLUMN issuer VARCHAR(255) NULL AFTER title', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_awards' AND COLUMN_NAME = 'image_url');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_awards ADD COLUMN image_url VARCHAR(512) NULL AFTER award_year', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS doctor_testimonials (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id         BIGINT UNSIGNED NOT NULL,
  patient_name      VARCHAR(120) NOT NULL,
  patient_photo_url VARCHAR(512) NULL,
  review_text       VARCHAR(1500) NOT NULL,
  rating            TINYINT UNSIGNED NOT NULL,
  review_date       DATE NULL,
  is_visible        TINYINT(1) NOT NULL DEFAULT 1,
  display_order     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_testimonial_doctor (doctor_id, display_order),
  CONSTRAINT fk_testimonial_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT chk_testimonial_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
