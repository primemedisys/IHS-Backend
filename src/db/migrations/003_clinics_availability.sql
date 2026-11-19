-- ============================================================================
-- 003 — Clinics & Availability (docs/clinics-availability/backend-plan.md §1)
--
-- Lifts the four multi-clinic + availability tables verbatim from
-- docs/dbstruct.md §8–11 (PRD §4.3a): a doctor's physical clinics, each clinic's
-- own weekly schedule, the doctor's independent online/video schedule, and
-- blocked-date exceptions. Idempotent (CREATE TABLE IF NOT EXISTS) so it's safe
-- to re-run and safe alongside the dev-time sequelize.sync().
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME). NO doctor_profiles change — online_fee
-- already exists and is edited via PATCH /doctor/profile.
-- ============================================================================

-- ── 8. CLINICS — (1:M) doctor -> many clinics (dbstruct.md §8) ───────────────
CREATE TABLE IF NOT EXISTS clinics (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(150) NOT NULL,
    address_line VARCHAR(255) NOT NULL,
    city         VARCHAR(100) NULL,
    state        VARCHAR(100) NULL,
    pincode      VARCHAR(20)  NULL,
    lat          DECIMAL(10,7) NOT NULL,
    lng          DECIMAL(10,7) NOT NULL,
    phone        VARCHAR(20)  NULL,
    offline_fee  DECIMAL(10,2) NOT NULL,
    is_active    TINYINT(1) NOT NULL DEFAULT 1,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_clinic_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_clinic_doctor (doctor_id),
    KEY idx_clinic_geo (lat, lng)
) ENGINE=InnoDB;

-- ── 9. CLINIC AVAILABILITY — (1:M) clinic -> weekly recurring slots (§9) ─────
CREATE TABLE IF NOT EXISTS clinic_availability (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    clinic_id      BIGINT UNSIGNED NOT NULL,
    day_of_week    TINYINT UNSIGNED NOT NULL,          -- 0=Sunday .. 6=Saturday
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    slot_duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
    is_active      TINYINT(1) NOT NULL DEFAULT 1,

    CONSTRAINT fk_clinicavail_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE,
    KEY idx_clinicavail_clinic_day (clinic_id, day_of_week)
) ENGINE=InnoDB;

-- ── 10. DOCTOR ONLINE AVAILABILITY — (1:M) doctor -> video slots (§10) ───────
--       Independent of any clinic.
CREATE TABLE IF NOT EXISTS doctor_online_availability (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id      BIGINT UNSIGNED NOT NULL,
    day_of_week    TINYINT UNSIGNED NOT NULL,
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    slot_duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
    is_active      TINYINT(1) NOT NULL DEFAULT 1,

    CONSTRAINT fk_onlineavail_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_onlineavail_doctor_day (doctor_id, day_of_week)
) ENGINE=InnoDB;

-- ── 11. AVAILABILITY EXCEPTIONS — (1:M) doctor -> blocked dates (§11) ────────
--       Optionally scoped to one clinic; NULL clinic_id = an online exception.
CREATE TABLE IF NOT EXISTS availability_exceptions (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id      BIGINT UNSIGNED NOT NULL,
    clinic_id      BIGINT UNSIGNED NULL,
    exception_date DATE NOT NULL,
    reason         VARCHAR(255) NULL,

    CONSTRAINT fk_exception_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_exception_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE,
    KEY idx_exception_doctor_date (doctor_id, exception_date)
) ENGINE=InnoDB;
