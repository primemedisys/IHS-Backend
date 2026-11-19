-- ============================================================================
-- 017 — Clinic accounts
--
-- Adds the fourth role and the profile table behind it.
--
-- The users.role ALTER is REQUIRED, not cosmetic: 000_base_schema is already
-- recorded in _migrations and never re-runs, so the enum on an existing install
-- is still the original three values and would reject role='clinic' outright.
--
-- `clinic_profiles` mirrors `doctor_profiles` deliberately — same PK-is-the-FK
-- shape, same verification_status / is_submitted pair — so the admin approval
-- queue, the onboarding checklist and the serializers all read the same way for
-- both. NOT the existing `clinics` table: that one is NOT NULL doctor_id with
-- ON DELETE CASCADE, i.e. one doctor's location, with nothing to sign in as.
--
-- Idempotent (information_schema-guarded) like 013-016.
-- ============================================================================

-- ── users.role enum ─────────────────────────────────────────────────────────
-- Guarded on the literal so re-running is a no-op; MODIFY of an identical
-- definition would otherwise rewrite the table on every deploy.
SET @hasClinic := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
    AND COLUMN_TYPE LIKE '%clinic%');
SET @ddl := IF(@hasClinic = 0,
  "ALTER TABLE users MODIFY role ENUM('patient','doctor','admin','clinic') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── clinic_profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_profiles (
  user_id             BIGINT UNSIGNED NOT NULL,
  clinic_name         VARCHAR(150)    NOT NULL,
  registration_number VARCHAR(100)    NULL,
  phone               VARCHAR(20)     NULL,
  address_line        VARCHAR(255)    NULL,
  city                VARCHAR(100)    NULL,
  state               VARCHAR(100)    NULL,
  pincode             VARCHAR(10)     NULL,
  -- Same precision as clinics.lat/lng so the existing map picker and any
  -- future geo query work against both tables unchanged.
  lat                 DECIMAL(10,7)   NULL,
  lng                 DECIMAL(10,7)   NULL,
  logo_url            VARCHAR(512)    NULL,
  about               VARCHAR(1000)   NULL,
  verification_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  is_submitted        TINYINT(1)      NOT NULL DEFAULT 0,
  verification_notes  VARCHAR(500)    NULL,
  is_active           TINYINT(1)      NOT NULL DEFAULT 1,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_clinic_profiles_status (verification_status),
  CONSTRAINT fk_clinic_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── clinic_documents ────────────────────────────────────────────────────────
-- Verification paperwork, mirroring doctor_documents. ON DELETE CASCADE is
-- correct here (unlike medical records): a document belongs to the account.
CREATE TABLE IF NOT EXISTS clinic_documents (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id    BIGINT UNSIGNED NOT NULL,
  doc_type     VARCHAR(50)     NOT NULL,
  file_url     VARCHAR(512)    NOT NULL,
  file_name    VARCHAR(255)    NULL,
  storage_key  VARCHAR(512)    NULL,
  uploaded_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_clinic_documents_clinic (clinic_id),
  CONSTRAINT fk_clinic_documents_clinic FOREIGN KEY (clinic_id) REFERENCES clinic_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
