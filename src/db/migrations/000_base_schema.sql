-- ============================================================================
-- IHS / Primemedisys - CONSOLIDATED MYSQL BASELINE
-- Generated from the supplied migration dump (000-060) and current Sequelize
-- model dump dated 2026-11-20.
--
-- This file intentionally folds the historical numbered migrations into one
-- first-install schema script. Run ONLY this file on a brand-new empty DB.
-- Do not run the old numbered migrations after this baseline.
--
-- Requires mysql2 connection with multipleStatements=true (as in migrate.js).
-- MySQL DDL is not transactional; if this script fails, DROP and recreate the
-- local database before retrying.
-- ============================================================================


-- ==========================================================================
-- BEGIN folded migration: 000_base_schema.sql
-- ==========================================================================
-- ============================================================================
-- Doctor–Patient Consultation Platform — Full MySQL Schema (Normalized)
-- Engine: InnoDB (needed for foreign keys) | Charset: utf8mb4
--
-- RELATIONSHIP LEGEND used in comments throughout:
--   (1:1)  one-to-one      e.g. users -> doctor_profiles
--   (1:M)  one-to-many     e.g. doctor -> clinics
--   (M:1)  many-to-one     e.g. bookings -> doctor (the "child side" of a 1:M)
--   (M:N)  many-to-many    e.g. doctor <-> specializations, via a junction table
-- ============================================================================

-- No CREATE DATABASE / USE here on purpose: src/db/migrate.js already runs
-- `CREATE DATABASE IF NOT EXISTS <DB_NAME>` and `USE <DB_NAME>` against
-- whichever database env.DB_NAME points at before executing this file, so a
-- hardcoded db name here would silently redirect every environment (prod,
-- dev, ...) onto the same physical database regardless of its own DB_NAME.

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
-- 1. USERS  (patients, doctors, admins and CLINICS all live here — role decides the rest)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role              ENUM('patient','doctor','admin','clinic') NOT NULL,  -- 'clinic' added by migration 017
    name              VARCHAR(150) NOT NULL,
    email             VARCHAR(190) NOT NULL,
    phone             VARCHAR(20)  NULL,
    password_hash     VARCHAR(255) NULL,              -- NULL if user signed up via Google only
    auth_provider     ENUM('local','google') NOT NULL DEFAULT 'local',
    google_id         VARCHAR(190) NULL,
    profile_photo_url VARCHAR(500) NULL,
    is_active         TINYINT(1) NOT NULL DEFAULT 1,
    is_email_verified TINYINT(1) NOT NULL DEFAULT 0,
    is_phone_verified TINYINT(1) NOT NULL DEFAULT 0,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_users_email (email),
    UNIQUE KEY uq_users_google_id (google_id),
    KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. PATIENT PROFILES  (1:1 -> users, where role='patient')
-- ============================================================================
CREATE TABLE IF NOT EXISTS patient_profiles (
    user_id               BIGINT UNSIGNED PRIMARY KEY,
    date_of_birth         DATE NULL,
    gender                ENUM('male','female','other') NULL,
    height_cm             DECIMAL(5,2) NULL,
    weight_kg             DECIMAL(5,2) NULL,
    bmi                   DECIMAL(5,2) NULL,
    blood_group           ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown') NULL DEFAULT 'unknown',
    emergency_contact_name  VARCHAR(150) NULL,
    emergency_contact_phone VARCHAR(20)  NULL,
    address_line          VARCHAR(255) NULL,
    city                  VARCHAR(100) NULL,
    state                 VARCHAR(100) NULL,
    pincode               VARCHAR(20)  NULL,
    lat                   DECIMAL(10,7) NULL,
    lng                   DECIMAL(10,7) NULL,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_patientprofile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2a. ALLERGIES lookup + patient<->allergy junction  ==>  (M:N)
--     Was previously a free-text/JSON column. Normalized so allergies are
--     queryable ("find all patients allergic to penicillin") and consistent.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allergies (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_allergy_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS patient_allergies (                          -- (M:N) junction
    patient_id  BIGINT UNSIGNED NOT NULL,
    allergy_id  INT UNSIGNED NOT NULL,
    severity    ENUM('mild','moderate','severe') NULL,
    PRIMARY KEY (patient_id, allergy_id),
    CONSTRAINT fk_patalg_patient FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patalg_allergy FOREIGN KEY (allergy_id) REFERENCES allergies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2b. CONDITIONS lookup + patient<->condition junction  ==>  (M:N)
--     Same normalization for chronic conditions (diabetes, hypertension...).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conditions (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_condition_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS patient_conditions (                          -- (M:N) junction
    patient_id    BIGINT UNSIGNED NOT NULL,
    condition_id  INT UNSIGNED NOT NULL,
    diagnosed_year SMALLINT UNSIGNED NULL,
    PRIMARY KEY (patient_id, condition_id),
    CONSTRAINT fk_patcond_patient   FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patcond_condition FOREIGN KEY (condition_id) REFERENCES conditions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2c. PATIENT CURRENT MEDICATIONS  ==>  (1:M) patient -> many med rows
--     Not a lookup+junction (M:N) because dosage/notes are specific to that
--     patient's entry, not a reusable attribute like an allergy name.
-- ----------------------------------------------------------------------------
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 3. FAMILY MEMBERS  ==>  (1:M) patient -> many dependents
-- ============================================================================
CREATE TABLE IF NOT EXISTS family_members (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id   BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(150) NOT NULL,
    relation     VARCHAR(50)  NULL,
    age          SMALLINT UNSIGNED NULL,
    gender       ENUM('male','female','other') NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_family_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 4. SPECIALIZATIONS lookup (Cardiologist, Dermatologist, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS specializations (
    id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name   VARCHAR(120) NOT NULL,
    slug   VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_spec_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 5. LANGUAGES lookup + doctor<->language junction  ==>  (M:N)
--    Was previously a comma-separated column on doctor_profiles.
-- ============================================================================
CREATE TABLE IF NOT EXISTS languages (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(60) NOT NULL,
    UNIQUE KEY uq_language_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6. DOCTOR PROFILES  ==>  (1:1) users -> doctor_profiles
--    NOTE: bank/payout details are intentionally NOT here — see
--    doctor_bank_details below. Keeping financial data in its own table
--    means it can carry its own access controls, audit trail, and can hold
--    a history of accounts (a doctor may change bank accounts over time)
--    without mutating the doctor's public profile row.
-- ============================================================================
CREATE TABLE IF NOT EXISTS doctor_profiles (
    user_id              BIGINT UNSIGNED PRIMARY KEY,
    qualification         VARCHAR(255) NULL,           -- short display summary e.g. "MBBS, MD (Cardiology)"
    registration_number   VARCHAR(100) NOT NULL,
    experience_years       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    bio                    TEXT NULL,
    -- ── Portfolio hero / about / contact fields (added by migration 004) ─────
    headline               VARCHAR(160) NULL,           -- Hero tagline e.g. "Board-Certified Cardiologist"  [REQUIRED to submit]
    gender                 ENUM('male','female','other') NULL,   -- Hero + public card                       [REQUIRED to submit]
    practice_philosophy    VARCHAR(1000) NULL,          -- "About" — philosophy of care / what's unique (optional)
    public_phone           VARCHAR(20)  NULL,           -- Contact section (falls back to users.phone)          [REQUIRED to submit]
    public_email           VARCHAR(190) NULL,           -- Contact section (falls back to users.email)          [REQUIRED to submit]
    online_fee             DECIMAL(10,2) NULL,          -- NULL = doctor doesn't offer video consults
    verification_status    ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    verification_notes     VARCHAR(500) NULL,
    avg_rating             DECIMAL(3,2) NOT NULL DEFAULT 0.00,
    rating_count            INT UNSIGNED NOT NULL DEFAULT 0,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_doctorprofile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_doctor_reg_number (registration_number),
    KEY idx_doctor_verification (verification_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6a. DOCTOR BANK / PAYOUT DETAILS  ==>  (1:1) doctor -> current payout account
--     Split out from doctor_profiles. A doctor has exactly one ACTIVE payout
--     account at a time (enforced by is_active + application logic), but this
--     table can hold history (old rows kept with is_active=0) — something
--     impossible to represent if it were columns on doctor_profiles.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_bank_details (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id             BIGINT UNSIGNED NOT NULL,
    account_holder_name   VARCHAR(150) NOT NULL,
    account_number        VARCHAR(50)  NOT NULL,          -- store encrypted at the application layer
    ifsc_code              VARCHAR(20)  NOT NULL,
    razorpay_account_id    VARCHAR(100) NULL,              -- Razorpay Route linked account, for split payouts
    is_active               TINYINT(1) NOT NULL DEFAULT 1,
    created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_bankdetails_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_bankdetails_doctor_active (doctor_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6b. DOCTOR AWARDS / ACHIEVEMENTS  ==>  (1:M) doctor -> many award rows
--     Normalized out of the old free-text/JSON column for a proper portfolio.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_awards (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    title        VARCHAR(255) NOT NULL,
    description  VARCHAR(500) NULL,
    award_year   SMALLINT UNSIGNED NULL,

    CONSTRAINT fk_award_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_award_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6c. DOCTOR SOCIAL / WEB LINKS  ==>  (1:M) doctor -> many link rows
--     Normalized instead of fixed linkedin_url/website_url columns, so a
--     doctor can add Instagram, YouTube, a personal site, etc. without a
--     schema change every time a new platform matters.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_links (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    link_type    ENUM('website','linkedin','instagram','youtube','other') NOT NULL,
    url          VARCHAR(300) NOT NULL,

    CONSTRAINT fk_link_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_link_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6d. DOCTOR <-> SPECIALIZATION  ==>  (M:N)  a doctor can have 1+ specialties,
--     a specialty has many doctors.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_specializations (
    doctor_id          BIGINT UNSIGNED NOT NULL,
    specialization_id  INT UNSIGNED NOT NULL,

    PRIMARY KEY (doctor_id, specialization_id),
    CONSTRAINT fk_docspec_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docspec_spec   FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6e. DOCTOR <-> LANGUAGE  ==>  (M:N)  a doctor speaks many languages,
--     a language is spoken by many doctors.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_languages (
    doctor_id    BIGINT UNSIGNED NOT NULL,
    language_id  INT UNSIGNED NOT NULL,

    PRIMARY KEY (doctor_id, language_id),
    CONSTRAINT fk_doclang_doctor   FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_doclang_language FOREIGN KEY (language_id) REFERENCES languages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6f–6m. PORTFOLIO CONTENT TABLES  (added by migration 004_doctor_portfolio_v2)
--   These flesh out the public portfolio's remaining sections. Each row belongs
--   to one doctor (1:M). `display_order` lets the doctor order cards in the UI.
--   REQUIRED-to-submit sections are marked; the rest are optional-but-encouraged
--   (the submit gate reads ONBOARDING_REQUIRED_STEPS in config/constants.js).
-- ============================================================================

-- 6f. DOCTOR EDUCATION  ==>  (1:M)  structured qualifications & schooling  [REQUIRED >=1]
CREATE TABLE IF NOT EXISTS doctor_education (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    degree        VARCHAR(150) NOT NULL,               -- e.g. "MD - Cardiology"
    institution   VARCHAR(200) NOT NULL,               -- e.g. "AIIMS, New Delhi"
    field_of_study VARCHAR(150) NULL,
    year_from     SMALLINT UNSIGNED NULL,
    year_to       SMALLINT UNSIGNED NULL,              -- NULL = ongoing
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_education_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_education_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6g. DOCTOR EXPERIENCE  ==>  (1:M)  career timeline (hospitals / positions)  [REQUIRED >=1]
CREATE TABLE IF NOT EXISTS doctor_experience (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    organization  VARCHAR(200) NOT NULL,               -- hospital / clinic name
    role_title    VARCHAR(150) NOT NULL,               -- e.g. "Senior Consultant"
    start_year    SMALLINT UNSIGNED NOT NULL,
    end_year      SMALLINT UNSIGNED NULL,              -- NULL when is_current=1
    is_current    TINYINT(1) NOT NULL DEFAULT 0,
    description   VARCHAR(500) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_experience_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_experience_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6h. DOCTOR SERVICES  ==>  (1:M)  procedures / treatments offered  [REQUIRED >=1]
CREATE TABLE IF NOT EXISTS doctor_services (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(150) NOT NULL,               -- e.g. "Angioplasty"
    description   VARCHAR(500) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_service_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_service_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6i. DOCTOR PUBLICATIONS & RESEARCH  ==>  (1:M)  papers / journals  (optional)
CREATE TABLE IF NOT EXISTS doctor_publications (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    title         VARCHAR(300) NOT NULL,
    publisher     VARCHAR(200) NULL,                   -- journal / conference name
    year          SMALLINT UNSIGNED NULL,
    url           VARCHAR(300) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_publication_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_publication_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6j. DOCTOR MEMBERSHIPS  ==>  (1:M)  medical bodies / associations  (optional)
CREATE TABLE IF NOT EXISTS doctor_memberships (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    organization  VARCHAR(200) NOT NULL,               -- e.g. "Medical Council of India"
    role_title    VARCHAR(150) NULL,                   -- e.g. "Fellow", "Life Member"
    since_year    SMALLINT UNSIGNED NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_membership_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_membership_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6k. DOCTOR GALLERY  ==>  (1:M)  clinic / practice photos  (optional)
CREATE TABLE IF NOT EXISTS doctor_gallery (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    image_url     VARCHAR(500) NOT NULL,
    caption       VARCHAR(255) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_gallery_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_gallery_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6l. DOCTOR FAQ  ==>  (1:M)  common patient questions  (optional)
CREATE TABLE IF NOT EXISTS doctor_faqs (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    question      VARCHAR(300) NOT NULL,
    answer        VARCHAR(1000) NOT NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_faq_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_faq_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6m. INSURANCE lookup + doctor<->insurance junction  ==>  (M:N)  (optional)
--     Normalized so "find doctors accepting <provider>" is queryable, mirroring
--     the specializations/languages pattern.
CREATE TABLE IF NOT EXISTS insurances (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(150) NOT NULL,
    UNIQUE KEY uq_insurance_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doctor_insurances (                          -- (M:N) junction
    doctor_id     BIGINT UNSIGNED NOT NULL,
    insurance_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (doctor_id, insurance_id),
    CONSTRAINT fk_docins_doctor    FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docins_insurance FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 7. DOCTOR DOCUMENTS  ==>  (1:M) doctor -> many uploaded documents
-- ============================================================================
CREATE TABLE IF NOT EXISTS doctor_documents (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    doc_type     ENUM('degree_certificate','id_proof','council_registration','other') NOT NULL,
    file_url     VARCHAR(500) NOT NULL,
    uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_docdoc_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_docdoc_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 8. CLINICS  ==>  (1:M) doctor -> many clinics
-- ============================================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 9. CLINIC AVAILABILITY  ==>  (1:M) clinic -> many recurring weekly slots
-- ============================================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 10. DOCTOR ONLINE AVAILABILITY  ==>  (1:M) doctor -> many video-consult slots
--     Independent of any clinic.
-- ============================================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 11. AVAILABILITY EXCEPTIONS  ==>  (1:M) doctor -> many blocked dates,
--     optionally scoped to one (M:1) clinic; NULL clinic_id = online.
-- ============================================================================
CREATE TABLE IF NOT EXISTS availability_exceptions (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id      BIGINT UNSIGNED NOT NULL,
    clinic_id      BIGINT UNSIGNED NULL,
    exception_date DATE NOT NULL,
    reason         VARCHAR(255) NULL,

    CONSTRAINT fk_exception_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_exception_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE,
    KEY idx_exception_doctor_date (doctor_id, exception_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12. BOOKINGS  ==>  (M:1) to patient, (M:1) to doctor, (M:1) to clinic
--     (nullable), (M:1) to family_member (nullable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id       BIGINT UNSIGNED NOT NULL,
    family_member_id BIGINT UNSIGNED NULL,
    doctor_id        BIGINT UNSIGNED NOT NULL,
    clinic_id        BIGINT UNSIGNED NULL,              -- NULL = video consult booking
    booking_type     ENUM('online','offline') NOT NULL,
    slot_date        DATE NOT NULL,
    slot_start_time  TIME NOT NULL,
    slot_end_time    TIME NOT NULL,
    status           ENUM('pending_payment','confirmed','completed','cancelled','no_show') NOT NULL DEFAULT 'pending_payment',
    payment_mode     ENUM('online','offline') NOT NULL,
    amount           DECIMAL(10,2) NOT NULL,
    meet_link        VARCHAR(500) NULL,
    meet_event_id    VARCHAR(255) NULL,
    cancelled_reason  VARCHAR(255) NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- prevents double-booking the same doctor at the same date+time
    active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
        CASE WHEN status IN ('pending_payment','confirmed')
             THEN CONCAT(doctor_id, '_', slot_date, '_', slot_start_time)
             ELSE NULL END
    ) STORED,

    CONSTRAINT fk_booking_patient FOREIGN KEY (patient_id) REFERENCES users(id),
    CONSTRAINT fk_booking_family  FOREIGN KEY (family_member_id) REFERENCES family_members(id),
    CONSTRAINT fk_booking_doctor  FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id),
    CONSTRAINT fk_booking_clinic  FOREIGN KEY (clinic_id) REFERENCES clinics(id),

    UNIQUE KEY uq_booking_doctor_slot_lock (active_lock_key),
    KEY idx_booking_patient (patient_id),
    KEY idx_booking_doctor_date (doctor_id, slot_date),
    KEY idx_booking_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 13. PAYMENTS  ==>  (1:1) booking -> payment
-- ============================================================================
CREATE TABLE IF NOT EXISTS payments (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id         BIGINT UNSIGNED NOT NULL,
    amount             DECIMAL(10,2) NOT NULL,
    mode               ENUM('online','offline') NOT NULL,
    status             ENUM('initiated','success','failed','refunded','pending_at_clinic') NOT NULL DEFAULT 'initiated',
    razorpay_order_id  VARCHAR(100) NULL,
    razorpay_payment_id VARCHAR(100) NULL,
    razorpay_signature  VARCHAR(255) NULL,
    commission_amount   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    doctor_payout_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    paid_at             DATETIME NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    UNIQUE KEY uq_payment_booking (booking_id),
    KEY idx_payment_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 14. PRESCRIPTIONS  ==>  (1:1) booking -> prescription
--
-- !! SUPERSEDED by migration 006_prescriptions.sql (docs/prescriptions/).
-- The table below is the original sketch: no configurable letterhead, no
-- draft/finalized lifecycle, no versioning, and a UNIQUE(booking_id) that makes
-- amendment structurally impossible. Migration 006 DROPs and recreates both
-- this table and prescription_items, and adds prescription_templates.
--
-- It is left here verbatim on purpose: this file is applied as `000_base_schema`
-- BEFORE the numbered migrations, so rewriting it would just make 006 drop and
-- recreate the same thing. Read backend/src/db/migrations/006_prescriptions.sql
-- for the live schema.
-- ============================================================================
CREATE TABLE IF NOT EXISTS prescriptions (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id        BIGINT UNSIGNED NOT NULL,
    doctor_id         BIGINT UNSIGNED NOT NULL,
    patient_id        BIGINT UNSIGNED NOT NULL,
    height_cm         DECIMAL(5,2) NULL,
    weight_kg         DECIMAL(5,2) NULL,
    blood_pressure    VARCHAR(20) NULL,
    pulse_rate_bpm    SMALLINT UNSIGNED NULL,
    temperature_f     DECIMAL(4,1) NULL,
    spo2_percent      TINYINT UNSIGNED NULL,
    diagnosis         VARCHAR(500) NULL,
    notes             TEXT NULL,
    advice            TEXT NULL,
    follow_up_date    DATE NULL,
    digital_signature_url VARCHAR(500) NULL,
    pdf_url           VARCHAR(500) NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_prescription_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    CONSTRAINT fk_prescription_doctor  FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id),
    CONSTRAINT fk_prescription_patient FOREIGN KEY (patient_id) REFERENCES users(id),
    UNIQUE KEY uq_prescription_booking (booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 15. PRESCRIPTION ITEMS  ==>  (1:M) prescription -> many medicine rows
-- !! SUPERSEDED by migration 006_prescriptions.sql — see the note on §14.
-- ============================================================================
CREATE TABLE IF NOT EXISTS prescription_items (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prescription_id BIGINT UNSIGNED NOT NULL,
    medicine_name   VARCHAR(200) NOT NULL,
    dosage          VARCHAR(100) NULL,
    route           ENUM('oral','topical','injection','drops','inhaler','other') NOT NULL DEFAULT 'oral',
    frequency       VARCHAR(100) NULL,
    timing          ENUM('before_food','after_food','with_food','anytime') NULL DEFAULT 'after_food',
    duration_days   SMALLINT UNSIGNED NULL,
    notes           VARCHAR(255) NULL,

    CONSTRAINT fk_rxitem_prescription FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 16. UPLOADED RECORDS  ==>  (1:M) patient -> many uploaded past records
-- ============================================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 17. REVIEWS  ==>  (1:1) booking -> review, (M:1) to patient, (M:1) to doctor
-- ============================================================================
CREATE TABLE IF NOT EXISTS reviews (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id   BIGINT UNSIGNED NOT NULL,
    patient_id   BIGINT UNSIGNED NOT NULL,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    rating       TINYINT UNSIGNED NOT NULL,
    comment      VARCHAR(1000) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_review_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    CONSTRAINT fk_review_patient FOREIGN KEY (patient_id) REFERENCES users(id),
    CONSTRAINT fk_review_doctor  FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id),
    UNIQUE KEY uq_review_booking (booking_id),
    CONSTRAINT chk_review_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 18. SEARCH ALGORITHM TABLES — two layers: platform DEFAULTS + per-doctor ADD-ONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 18a. SYMPTOM -> SPECIALIZATION MAP  ==>  (M:1) each row -> one specialization
--      This is the GLOBAL DEFAULT layer, set by the platform/admin, e.g.
--      "chest pain" -> Cardiologist. Applies to every doctor in that
--      specialization automatically — a doctor doesn't have to do anything
--      for this layer to work.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS symptom_specialization_map (
    id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    symptom_keyword    VARCHAR(150) NOT NULL,
    specialization_id  INT UNSIGNED NOT NULL,
    weight             TINYINT UNSIGNED NOT NULL DEFAULT 1,

    CONSTRAINT fk_symptom_spec FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE,
    KEY idx_symptom_keyword (symptom_keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 18b. DOCTOR SEARCH KEYWORDS  ==>  (1:M) doctor -> many self-added keywords
--      This is the PER-DOCTOR ADD-ON layer. A doctor can tag themselves for
--      symptoms beyond what their specialization implies by default — e.g.
--      an Orthopedic doctor who specifically treats "leg pain" and wants to
--      show up for that exact search, even if "leg pain" isn't in the global
--      symptom_specialization_map. Doctor adds these from their dashboard;
--      admin can moderate/reject irrelevant ones via is_approved.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_search_keywords (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    keyword      VARCHAR(150) NOT NULL,
    weight       TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- doctor/admin can boost relevance
    is_approved  TINYINT(1) NOT NULL DEFAULT 1,          -- admin can moderate self-added tags
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_doctorkeyword_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    UNIQUE KEY uq_doctor_keyword (doctor_id, keyword),
    KEY idx_doctorkeyword_keyword (keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 19. EMAIL NOTIFICATIONS LOG  ==>  (1:M) user -> many sent emails,
--     (M:1) optionally tied to one booking
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_notifications (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      BIGINT UNSIGNED NOT NULL,
    booking_id   BIGINT UNSIGNED NULL,
    type         ENUM('booking_confirmation','reminder_24h','reminder_30min',
                       'payment_receipt','prescription_ready','cancellation','other') NOT NULL,
    to_email     VARCHAR(190) NOT NULL,
    subject      VARCHAR(255) NOT NULL,
    status       ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
    sent_at      DATETIME NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notif_user    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_notif_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
    KEY idx_notif_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- SEED DATA (minimal, for local dev/testing)
-- ============================================================================
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

INSERT IGNORE INTO insurances (name) VALUES
  ('Star Health'), ('HDFC ERGO'), ('ICICI Lombard'), ('Niva Bupa'),
  ('LIC Health'), ('CGHS'), ('Ayushman Bharat (PM-JAY)'), ('Self-pay / No insurance');

INSERT IGNORE INTO allergies (name) VALUES
  ('Penicillin'), ('Dust'), ('Pollen'), ('Peanuts'), ('Latex');

INSERT IGNORE INTO conditions (name) VALUES
  ('Diabetes'), ('Hypertension'), ('Asthma'), ('Hypothyroidism'), ('Arthritis');

-- global default symptom -> specialization mapping
INSERT INTO symptom_specialization_map (symptom_keyword, specialization_id, weight)
SELECT 'chest pain', 1, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'chest pain' AND specialization_id = 1
)
UNION ALL
SELECT 'palpitations', 1, 4
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'palpitations' AND specialization_id = 1
)
UNION ALL
SELECT 'skin rash', 2, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'skin rash' AND specialization_id = 2
)
UNION ALL
SELECT 'acne', 2, 3
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'acne' AND specialization_id = 2
)
UNION ALL
SELECT 'fever', 3, 3
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'fever' AND specialization_id = 3
)
UNION ALL
SELECT 'cold and cough', 3, 3
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'cold and cough' AND specialization_id = 3
)
UNION ALL
SELECT 'child fever', 4, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'child fever' AND specialization_id = 4
)
UNION ALL
SELECT 'joint pain', 5, 4
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'joint pain' AND specialization_id = 5
)
UNION ALL
SELECT 'back pain', 5, 4
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'back pain' AND specialization_id = 5
)
UNION ALL
SELECT 'leg pain', 5, 4
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'leg pain' AND specialization_id = 5
)
UNION ALL
SELECT 'ear pain', 6, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'ear pain' AND specialization_id = 6
)
UNION ALL
SELECT 'sore throat', 6, 3
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'sore throat' AND specialization_id = 6
)
UNION ALL
SELECT 'pregnancy', 7, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'pregnancy' AND specialization_id = 7
)
UNION ALL
SELECT 'anxiety', 8, 5
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'anxiety' AND specialization_id = 8
)
UNION ALL
SELECT 'sleep issues', 8, 3
WHERE NOT EXISTS (
  SELECT 1 FROM symptom_specialization_map
  WHERE symptom_keyword = 'sleep issues' AND specialization_id = 8
);

-- example: an Orthopedic doctor (user_id assumed 2077) self-tagging extra
-- keywords beyond the specialization default, e.g. to rank higher for
-- "leg pain" and "sports injury" searches specifically
-- INSERT INTO doctor_search_keywords (doctor_id, keyword, weight) VALUES
--   (2077, 'leg pain', 4),
--   (2077, 'sports injury', 3),
--   (2077, 'knee pain', 4);

-- ============================================================================
-- 20. CLINIC PORTAL  (migrations 017-019, docs/clinic-account)
--
-- A fourth account type: an ORGANISATION that logs in, holds a verified
-- profile, reads and writes any registered patient's record, and books
-- appointments with doctors on a patient's behalf.
--
-- NOT the `clinics` table above (§11), which is one DOCTOR'S LOCATION:
-- `clinics.doctor_id` is NOT NULL ON DELETE CASCADE, so there is nothing there
-- to sign in as. These are different concepts that unfortunately share a word.
-- ============================================================================

-- 20a. CLINIC PROFILES  ==>  (1:1) users -> clinic_profiles, where role='clinic'
--      Mirrors doctor_profiles: PK-is-the-FK, same verification_status /
--      is_submitted pair, so the onboarding checklist and the admin approval
--      queue read identically for a doctor and a clinic.
CREATE TABLE IF NOT EXISTS clinic_profiles (
    user_id             BIGINT UNSIGNED NOT NULL,
    clinic_name         VARCHAR(150)    NOT NULL,
    registration_number VARCHAR(100)    NULL,
    phone               VARCHAR(20)     NULL,
    address_line        VARCHAR(255)    NULL,
    city                VARCHAR(100)    NULL,
    state               VARCHAR(100)    NULL,
    pincode             VARCHAR(10)     NULL,
    -- Map location. Same precision as clinics.lat/lng so the existing picker
    -- and any future geo query work against both tables unchanged.
    lat                 DECIMAL(10,7)   NULL,
    lng                 DECIMAL(10,7)   NULL,
    logo_url            VARCHAR(512)    NULL,
    about               VARCHAR(1000)   NULL,
    -- Approval GATE: every /clinic/patients* route 403s until this is
    -- 'approved'. A clinic self-registers, so without it anyone with an email
    -- could read every patient on the platform.
    verification_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    is_submitted        TINYINT(1)      NOT NULL DEFAULT 0,
    verification_notes  VARCHAR(500)    NULL,
    -- Suspend without rejecting: the account and its history survive, access stops.
    is_active           TINYINT(1)      NOT NULL DEFAULT 1,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    KEY idx_clinic_profiles_status (verification_status),
    CONSTRAINT fk_clinic_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20b. CLINIC DOCUMENTS  ==>  (1:M) clinic_profiles -> verification paperwork
--      CASCADE is correct here (unlike a medical record): the document belongs
--      to the account.
CREATE TABLE IF NOT EXISTS clinic_documents (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinic_id    BIGINT UNSIGNED NOT NULL,
    doc_type     VARCHAR(50)     NOT NULL,  -- registration_certificate | id_proof | address_proof | other
    file_url     VARCHAR(512)    NOT NULL,
    file_name    VARCHAR(255)    NULL,
    storage_key  VARCHAR(512)    NULL,
    uploaded_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_clinic_documents_clinic (clinic_id),
    CONSTRAINT fk_clinic_documents_clinic FOREIGN KEY (clinic_id) REFERENCES clinic_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20c. RECORD PROVENANCE  (migration 018) — "who wrote this?"
--
-- The SAME two columns added to five record tables, so every record type reads
-- identically wherever it is displayed:
--
--   source              ENUM('patient','doctor','clinic')
--   recorded_by_user_id BIGINT UNSIGNED NULL, FK users(id) ON DELETE SET NULL
--
-- SET NULL, never CASCADE: deleting a clinic account must not delete the
-- medical records it wrote. The record outlives its author and loses only the
-- attribution — which is why every read of these tables LEFT JOINs the author.
--
--   patient_vitals       source widened in place (it already existed) + author
--   uploaded_records     both (no uploader column existed before)
--   patient_allergies    both
--   patient_conditions   both
--   clinical_notes       both, DEFAULT 'doctor', plus:
--                          - doctor_id becomes NULLABLE (a clinic note has no
--                            doctor, and that column FKs doctor_profiles)
--                          - a BACKFILL sets recorded_by_user_id = doctor_id on
--                            every existing row, or every note in the system
--                            would render as authorless.
--
-- CONSEQUENCE, by design: a clinic-written clinical note has booking_id NULL,
-- and the treatment timeline's spine is bookings — so it never appears as a
-- timeline row. It is rendered from the patient-keyed read on the Records page.

-- 20d. BOOKING AGENCY  (migration 019) — "X Clinic booked this for Y patient"
--
--   ALTER TABLE bookings
--     ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL,
--     ADD CONSTRAINT fk_bookings_booked_by FOREIGN KEY (booked_by_user_id)
--       REFERENCES users (id) ON DELETE SET NULL;
--   CREATE INDEX idx_bookings_booked_by ON bookings (booked_by_user_id);
--
-- NULL = the patient booked it themselves, which is every existing row and
-- every row the direct patient->doctor flow keeps creating. That flow is
-- completely unchanged by this feature.
--
-- Read by: the doctor's list ("Booked by X Clinic"), the patient's appointments
-- ("Booked for you by X"), the treatment timeline ("via X Clinic"), the
-- patient's prescription ("Consulted Dr. A via X Clinic"), and the video join
-- gate — a clinic may join ONLY a call whose booked_by_user_id is itself.

-- END folded migration: 000_base_schema.sql


-- ==========================================================================
-- BEGIN folded migration: 001_auth_tables.sql
-- ==========================================================================
-- ============================================================================
-- Auth tables (companion to docs/dbstruct.md). Run this against clinic_platform
-- in any environment where you are NOT letting Sequelize sync() create tables
-- (i.e. staging/production). Matches docs/auth/README.md §4.
-- (No `USE <db>` here: the migration runner already selects env.DB_NAME.)
-- ============================================================================

-- ── Refresh tokens: one row per active/rotated session ───────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    user_agent  VARCHAR(255) NULL,
    ip_address  VARCHAR(45)  NULL,
    expires_at  DATETIME NOT NULL,
    revoked_at  DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_refresh_token_hash (token_hash),
    KEY idx_refresh_user (user_id),
    KEY idx_refresh_expiry (expires_at)
) ENGINE=InnoDB;

-- ── Password reset tokens: single-use, short-lived ───────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_reset_token_hash (token_hash),
    KEY idx_reset_user (user_id)
) ENGINE=InnoDB;

-- END folded migration: 001_auth_tables.sql


-- ==========================================================================
-- BEGIN folded migration: 002_doctor_portfolio.sql
-- ==========================================================================
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

-- END folded migration: 002_doctor_portfolio.sql


-- ==========================================================================
-- BEGIN folded migration: 003_clinics_availability.sql
-- ==========================================================================
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

-- END folded migration: 003_clinics_availability.sql


-- ==========================================================================
-- BEGIN folded migration: 004_doctor_portfolio_v2.sql
-- ==========================================================================
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

-- END folded migration: 004_doctor_portfolio_v2.sql


-- ==========================================================================
-- BEGIN folded migration: 005_bookings_payments.sql
-- ==========================================================================
-- ============================================================================
-- 005 — Bookings & Payments (docs/booking-payments/backend-plan.md §1)
--
-- Lifts the bookings + payments tables verbatim from docs/dbstruct.md §12–13
-- (PRD §4.6–4.7), plus family_members (§3) which bookings.family_member_id
-- references. Idempotent (CREATE TABLE IF NOT EXISTS) so it's safe to re-run and
-- safe alongside the dev-time sequelize.sync().
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
--
-- The race-safety guard is the GENERATED `active_lock_key` + its UNIQUE key on
-- `bookings`: while a booking is a live hold (pending_payment/confirmed) the key
-- is `doctor_id_date_start`, so two patients can never hold the same slot; once
-- cancelled/completed the key is NULL and drops out of the unique index (MySQL
-- allows many NULLs), freeing the slot. In dev, sequelize.sync() cannot express
-- a STORED generated column, so db/ensureBookingLockKey.js adds it after sync —
-- this file is the source of truth for prod.
-- ============================================================================

-- ── 3. FAMILY MEMBERS — (1:M) patient -> dependents (dbstruct.md §3) ─────────
CREATE TABLE IF NOT EXISTS family_members (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id   BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(150) NOT NULL,
    relation     VARCHAR(50)  NULL,
    age          SMALLINT UNSIGNED NULL,
    gender       ENUM('male','female','other') NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_family_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 12. BOOKINGS — (M:1) patient/doctor/clinic(nullable)/family(nullable) (§12)
CREATE TABLE IF NOT EXISTS bookings (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id       BIGINT UNSIGNED NOT NULL,
    family_member_id BIGINT UNSIGNED NULL,
    doctor_id        BIGINT UNSIGNED NOT NULL,
    clinic_id        BIGINT UNSIGNED NULL,              -- NULL = video consult booking
    booking_type     ENUM('online','offline') NOT NULL,
    slot_date        DATE NOT NULL,
    slot_start_time  TIME NOT NULL,
    slot_end_time    TIME NOT NULL,
    status           ENUM('pending_payment','confirmed','completed','cancelled','no_show') NOT NULL DEFAULT 'pending_payment',
    payment_mode     ENUM('online','offline') NOT NULL,
    amount           DECIMAL(10,2) NOT NULL,
    meet_link        VARCHAR(500) NULL,
    meet_event_id    VARCHAR(255) NULL,
    cancelled_reason  VARCHAR(255) NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- prevents double-booking the same doctor at the same date+time while a hold
    -- is live. VIRTUAL (not STORED as in dbstruct.md) so the dev-time in-place
    -- ALTER in db/ensureBookingLockKey.js and this fresh CREATE stay identical;
    -- the UNIQUE index below materialises the value either way (MySQL 8 supports
    -- indexes on virtual columns), giving the same guard without disk storage.
    active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
        CASE WHEN status IN ('pending_payment','confirmed')
             THEN CONCAT(doctor_id, '_', slot_date, '_', slot_start_time)
             ELSE NULL END
    ) VIRTUAL,

    CONSTRAINT fk_booking_patient FOREIGN KEY (patient_id) REFERENCES users(id),
    CONSTRAINT fk_booking_family  FOREIGN KEY (family_member_id) REFERENCES family_members(id),
    CONSTRAINT fk_booking_doctor  FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id),
    CONSTRAINT fk_booking_clinic  FOREIGN KEY (clinic_id) REFERENCES clinics(id),

    UNIQUE KEY uq_booking_doctor_slot_lock (active_lock_key),
    KEY idx_booking_patient (patient_id),
    KEY idx_booking_doctor_date (doctor_id, slot_date),
    KEY idx_booking_status (status)
) ENGINE=InnoDB;

-- ── 13. PAYMENTS — (1:1) booking -> payment (§13) ────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id         BIGINT UNSIGNED NOT NULL,
    amount             DECIMAL(10,2) NOT NULL,
    mode               ENUM('online','offline') NOT NULL,
    status             ENUM('initiated','success','failed','refunded','pending_at_clinic') NOT NULL DEFAULT 'initiated',
    razorpay_order_id  VARCHAR(100) NULL,
    razorpay_payment_id VARCHAR(100) NULL,
    razorpay_signature  VARCHAR(255) NULL,
    commission_amount   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    doctor_payout_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    paid_at             DATETIME NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    UNIQUE KEY uq_payment_booking (booking_id),
    KEY idx_payment_status (status)
) ENGINE=InnoDB;

-- END folded migration: 005_bookings_payments.sql


-- ==========================================================================
-- BEGIN folded migration: 006_prescriptions.sql
-- ==========================================================================
-- ============================================================================
-- 006  PRESCRIPTIONS & CONFIGURABLE LETTERHEAD   (docs/prescriptions/)
--
-- `prescriptions` + `prescription_items` are created by the base schema
-- (docs/dbstruct.md §14-15) but were only ever a sketch: no letterhead, no
-- draft/finalized lifecycle, no versioning, and a UNIQUE(booking_id) that makes
-- amendment structurally impossible. Nothing has ever written a row to them
-- (the feature did not exist), so we DROP and recreate rather than bolt on a
-- dozen guarded ALTERs. See docs/prescriptions/backend-plan.md §3.
-- ============================================================================

DROP TABLE IF EXISTS prescription_items;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS prescription_templates;
DROP TABLE IF EXISTS rx_counters;

-- ----------------------------------------------------------------------------
-- 1. PRESCRIPTION TEMPLATES  ==>  (M:1) doctor, (M:1) clinic (NULL = video/any)
--
-- Scalar columns for anything the DATABASE needs (filter, sort, uniqueness,
-- cascade). JSON for the repeating presentation content the doctor reorders
-- freely and nothing ever queries. Every JSON blob is Joi-validated on write.
-- ----------------------------------------------------------------------------
CREATE TABLE prescription_templates (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id          BIGINT UNSIGNED NOT NULL,
    clinic_id          BIGINT UNSIGNED NULL,
    name               VARCHAR(120)    NOT NULL,
    is_default         BOOLEAN         NOT NULL DEFAULT FALSE,
    is_active          BOOLEAN         NOT NULL DEFAULT TRUE,

    -- branding assets (absolute URLs; storage keys recovered via keyFromUrl)
    logo_url           VARCHAR(500) NULL,
    watermark_url      VARCHAR(500) NULL,
    signature_url      VARCHAR(500) NULL,
    watermark_opacity  DECIMAL(3,2) NOT NULL DEFAULT 0.08,

    -- theme
    header_bg_color    CHAR(7)      NOT NULL DEFAULT '#7EE0EF',
    header_text_color  CHAR(7)      NOT NULL DEFAULT '#12263F',
    footer_bg_color    CHAR(7)      NOT NULL DEFAULT '#2E4A2E',
    footer_text_color  CHAR(7)      NOT NULL DEFAULT '#FFFFFF',
    accent_color       CHAR(7)      NOT NULL DEFAULT '#12263F',
    font_family        VARCHAR(60)  NOT NULL DEFAULT 'Helvetica, Arial, sans-serif',
    base_font_size_pt  DECIMAL(3,1) NOT NULL DEFAULT 10.0,

    -- page
    page_size          ENUM('A4','Letter') NOT NULL DEFAULT 'A4',
    margin_mm_top      SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_right    SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_bottom   SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_left     SMALLINT UNSIGNED NOT NULL DEFAULT 8,

    -- zone toggles
    show_header        BOOLEAN NOT NULL DEFAULT TRUE,
    show_footer        BOOLEAN NOT NULL DEFAULT TRUE,
    show_sidebar       BOOLEAN NOT NULL DEFAULT TRUE,
    show_watermark     BOOLEAN NOT NULL DEFAULT TRUE,
    sidebar_width_pct  TINYINT UNSIGNED NOT NULL DEFAULT 18,

    -- content (validated JSON — see validators/prescription.validator.js)
    header_json         JSON NOT NULL,
    patient_fields_json JSON NOT NULL,
    sidebar_json        JSON NOT NULL,
    body_json           JSON NOT NULL,
    footer_json         JSON NOT NULL,

    rx_number_prefix   VARCHAR(10) NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_rxtpl_doctor FOREIGN KEY (doctor_id)
        REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rxtpl_clinic FOREIGN KEY (clinic_id)
        REFERENCES clinics(id) ON DELETE SET NULL,
    UNIQUE KEY uq_rxtpl_name (doctor_id, clinic_id, name),
    KEY idx_rxtpl_doctor_active (doctor_id, is_active)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2. PRESCRIPTIONS  ==>  (1:1) booking per version
--
-- `template_snapshot` is the frozen copy of the letterhead taken at finalize.
-- A finalized prescription renders from the SNAPSHOT, never from the live
-- template — otherwise changing your logo silently rewrites every prescription
-- you ever signed. This is the load-bearing column of the whole feature.
--
-- booking_id is NULLABLE so walk-in prescriptions can land later; the MVP
-- always supplies one. MySQL's UNIQUE ignores NULLs, so they never collide.
-- ----------------------------------------------------------------------------
CREATE TABLE prescriptions (
    id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id             BIGINT UNSIGNED NULL,
    doctor_id              BIGINT UNSIGNED NOT NULL,
    patient_id             BIGINT UNSIGNED NOT NULL,
    clinic_id              BIGINT UNSIGNED NULL,
    template_id            BIGINT UNSIGNED NULL,

    status                 ENUM('draft','finalized') NOT NULL DEFAULT 'draft',
    rx_number              VARCHAR(40) NULL,
    version                SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    parent_prescription_id BIGINT UNSIGNED NULL,
    superseded_by_id       BIGINT UNSIGNED NULL,
    amend_reason           VARCHAR(255) NULL,

    -- clinical content
    chief_complaint  VARCHAR(500) NULL,
    height_cm        DECIMAL(5,2) NULL,
    weight_kg        DECIMAL(5,2) NULL,
    blood_pressure   VARCHAR(20)  NULL,
    pulse_rate_bpm   SMALLINT UNSIGNED NULL,
    temperature_f    DECIMAL(4,1) NULL,
    spo2_percent     TINYINT UNSIGNED NULL,
    diagnosis        VARCHAR(500) NULL,
    notes            TEXT NULL,
    advice           TEXT NULL,
    advice_selected  JSON NULL,
    follow_up_date   DATE NULL,

    -- the freeze
    template_snapshot JSON NULL,
    pdf_url           VARCHAR(500) NULL,
    finalized_at      DATETIME NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_rx_booking  FOREIGN KEY (booking_id)  REFERENCES bookings(id) ON DELETE CASCADE,
    CONSTRAINT fk_rx_doctor   FOREIGN KEY (doctor_id)   REFERENCES doctor_profiles(user_id),
    CONSTRAINT fk_rx_patient  FOREIGN KEY (patient_id)  REFERENCES users(id),
    CONSTRAINT fk_rx_clinic   FOREIGN KEY (clinic_id)   REFERENCES clinics(id) ON DELETE SET NULL,
    CONSTRAINT fk_rx_template FOREIGN KEY (template_id) REFERENCES prescription_templates(id) ON DELETE SET NULL,
    -- SET NULL, not RESTRICT: deleting a booking cascades to BOTH versions of
    -- its prescription, and MySQL does not order the cascade — a RESTRICT here
    -- would abort the delete depending on which row it reached first.
    CONSTRAINT fk_rx_parent   FOREIGN KEY (parent_prescription_id)
        REFERENCES prescriptions(id) ON DELETE SET NULL,

    UNIQUE KEY uq_rx_booking_version (booking_id, version),
    -- Scoped to the doctor, because the SEQUENCE is per-doctor (rx_counters).
    -- A global unique index would make two doctors who both pick the prefix
    -- 'OSC' collide on OSC-2026-000001 — the second one's finalize would 500.
    UNIQUE KEY uq_rx_number (doctor_id, rx_number),
    KEY idx_rx_doctor  (doctor_id, status),
    KEY idx_rx_patient (patient_id, status)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 3. PRESCRIPTION ITEMS  ==>  (1:M) prescription -> medicine rows
-- ----------------------------------------------------------------------------
CREATE TABLE prescription_items (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prescription_id BIGINT UNSIGNED NOT NULL,
    sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    medicine_id     BIGINT UNSIGNED NULL,
    medicine_name   VARCHAR(200) NOT NULL,
    dosage          VARCHAR(100) NULL,
    route           ENUM('oral','topical','injection','drops','inhaler','other') NOT NULL DEFAULT 'oral',
    frequency       VARCHAR(100) NULL,
    timing          ENUM('before_food','after_food','with_food','anytime') NULL DEFAULT 'after_food',
    duration_days   SMALLINT UNSIGNED NULL,
    notes           VARCHAR(255) NULL,

    CONSTRAINT fk_rxitem_prescription FOREIGN KEY (prescription_id)
        REFERENCES prescriptions(id) ON DELETE CASCADE,
    KEY idx_rxitem_rx (prescription_id, sort_order)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 4. RX COUNTERS  ==>  gapless per-doctor, per-year prescription numbering.
--
-- A `SELECT COUNT(*)` would gap-fill after a deleted draft and collide. The
-- atomic `INSERT ... ON DUPLICATE KEY UPDATE next_val = LAST_INSERT_ID(...)`
-- hands out one number per call with no read-modify-write race.
-- ----------------------------------------------------------------------------
CREATE TABLE rx_counters (
    doctor_id BIGINT UNSIGNED NOT NULL,
    year      SMALLINT UNSIGNED NOT NULL,
    next_val  INT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (doctor_id, year),
    CONSTRAINT fk_rxcounter_doctor FOREIGN KEY (doctor_id)
        REFERENCES doctor_profiles(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- END folded migration: 006_prescriptions.sql


-- ==========================================================================
-- BEGIN folded migration: 007_earnings_indexes.sql
-- ==========================================================================
-- ============================================================================
-- 007 — Dashboards & Earnings (docs/dashboards-earnings/backend-plan.md §2.3)
--
-- Three jobs, none of which add a business entity:
--   1. Refund bookkeeping columns on `payments`, so flipping a row to
--      'refunded' doesn't silently erase it from months already reported.
--   2. The composite indexes every dashboard aggregate range-scans on.
--   3. A BACKFILL of the commission split on offline payments confirmed through
--      booking.service.markPaid() before it learned to call applySplit(). Those
--      rows sit at status='success' with commission_amount = 0.00 and
--      doctor_payout_amount = 0.00 (the column defaults), which would make every
--      "pay at clinic" consult worth ₹0 to both the doctor and the platform.
--
-- Idempotent throughout (guarded DDL via information_schema, as in 004), so it
-- is safe to re-run and safe alongside a fresh base schema.
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
-- ============================================================================

-- ── 1. Refund bookkeeping on payments (README §4.3) ─────────────────────────
-- `paid_at` exists; there is no way to say WHEN a refund happened or how much
-- came back. Without these, a refund makes the row vanish from every
-- status='success' aggregate — including historical months already reported.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'refunded_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE payments ADD COLUMN refunded_at DATETIME NULL AFTER paid_at', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'refund_amount');
SET @ddl := IF(@has = 0,
  'ALTER TABLE payments ADD COLUMN refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER refunded_at',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. Aggregate indexes (README §4.2) ──────────────────────────────────────
-- MySQL 8 has no `CREATE INDEX IF NOT EXISTS`, so guard on information_schema
-- the same way 004 guards its column adds.

-- Every money query is `status='success' AND paid_at IN <range>`: leading with
-- the low-cardinality status, then range-scanning paid_at, is exactly the
-- access pattern. 005 indexed status alone, which degenerates to a full scan.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
    AND INDEX_NAME = 'idx_payment_status_paid_at');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_payment_status_paid_at ON payments (status, paid_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Doctor tiles filter (doctor_id, status) then range on slot_date. 005's
-- (doctor_id, slot_date) can't skip cancelled rows without a filesort.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
    AND INDEX_NAME = 'idx_booking_doctor_status_date');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_booking_doctor_status_date ON bookings (doctor_id, status, slot_date)',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Admin "bookings this month" ranges on slot_date across all doctors.
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
    AND INDEX_NAME = 'idx_booking_status_date');
SET @ddl := IF(@has = 0,
  'CREATE INDEX idx_booking_status_date ON bookings (status, slot_date)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. Backfill the offline commission split (README §4.1) ──────────────────
-- Scoped hard: only success rows whose split was never written. Re-running is a
-- no-op because the WHERE no longer matches.
--
-- The 0.15 is a LITERAL on purpose. It reconstructs what confirmPaid() stamped
-- on the contemporaneous ONLINE rows these are being reconciled against.
-- Importing PLATFORM_COMMISSION_PCT would make this migration produce different
-- results depending on when it is run; a migration must be a pure function of
-- the database. If the rate changes, this file keeps saying 0.15 forever.
UPDATE payments
   SET commission_amount    = ROUND(amount * 0.15, 2),
       doctor_payout_amount = ROUND(amount - ROUND(amount * 0.15, 2), 2)
 WHERE status = 'success'
   AND mode = 'offline'
   AND commission_amount = 0.00
   AND doctor_payout_amount = 0.00
   AND amount > 0;

-- END folded migration: 007_earnings_indexes.sql


-- ==========================================================================
-- BEGIN folded migration: 008_contact_messages.sql
-- ==========================================================================
-- ============================================================================
-- 008 — Contact messages (public "Contact us" form)
--
-- Stores submissions from the public contact form (frontend-patient /contact).
-- No auth and no FK: a visitor need not have an account. `handled` lets the
-- admin inbox mark a message as followed-up. Idempotent (IF NOT EXISTS) — safe
-- to re-run alongside the dev-time sequelize.sync().
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_messages (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    email       VARCHAR(255) NOT NULL,
    phone       VARCHAR(30)  NULL,
    message     TEXT NOT NULL,
    ip_address  VARCHAR(45)  NULL,               -- spam triage only
    handled     TINYINT(1) NOT NULL DEFAULT 0,   -- admin inbox: followed-up?
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_contact_created (created_at),
    INDEX idx_contact_handled (handled)
) ENGINE=InnoDB;

-- END folded migration: 008_contact_messages.sql


-- ==========================================================================
-- BEGIN folded migration: 009_clinical_notes.sql
-- ==========================================================================
-- ============================================================================
-- 009 — Clinical notes  (docs/clinical-notes/)
--
-- A patient-wide clinical log the doctor writes from an appointment: c/o (chief
-- complaint), o/e (on examination), h/o medical + surgical (history), diagnosis
-- and treatment. Notes are PATIENT-scoped (visible to every doctor who later
-- treats the patient), stamped with the AUTHORING doctor and the booking it was
-- written from. Append-only — a note is a medical record, not an editable field.
--
-- doctor_id references doctor_profiles.user_id (the same value as users.id for
-- that doctor), mirroring how bookings/prescriptions key their doctor FK.
-- Idempotent (CREATE TABLE IF NOT EXISTS) so it's safe to re-run.
--
-- NO `USE <db>` — the migration runner already selects env.DB_NAME.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clinical_notes (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id        BIGINT UNSIGNED NOT NULL,          -- users.id (the patient)
    doctor_id         BIGINT UNSIGNED NOT NULL,          -- doctor_profiles.user_id (author)
    booking_id        BIGINT UNSIGNED NULL,              -- the appointment it was written from

    complaints        TEXT NULL,                         -- c/o
    on_examination    TEXT NULL,                         -- o/e
    history_medical   TEXT NULL,                         -- h/o (medical)
    history_surgical  TEXT NULL,                         -- h/o (surgical)
    diagnosis         TEXT NULL,
    treatment         TEXT NULL,

    -- vitals (same shape/types as prescriptions.*): recorded per note, and the
    -- prescription create screen prefills from the most recent note's values.
    blood_pressure    VARCHAR(20)       NULL,
    pulse_rate_bpm    SMALLINT UNSIGNED  NULL,
    weight_kg         DECIMAL(5,2)       NULL,
    height_cm         DECIMAL(5,2)       NULL,
    temperature_f     DECIMAL(4,1)       NULL,
    spo2_percent      TINYINT UNSIGNED   NULL,

    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_clinical_notes_patient (patient_id, created_at),
    INDEX idx_clinical_notes_booking (booking_id),

    CONSTRAINT fk_clinical_notes_patient FOREIGN KEY (patient_id) REFERENCES users(id)            ON DELETE CASCADE,
    CONSTRAINT fk_clinical_notes_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_clinical_notes_booking FOREIGN KEY (booking_id) REFERENCES bookings(id)         ON DELETE SET NULL
) ENGINE=InnoDB;

-- END folded migration: 009_clinical_notes.sql


-- ==========================================================================
-- BEGIN folded migration: 010_patient_health.sql
-- ==========================================================================
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

-- END folded migration: 010_patient_health.sql


-- ==========================================================================
-- BEGIN folded migration: 011_referrals.sql
-- ==========================================================================
-- ============================================================================
-- 011 — Multi-doctor referrals & care journeys  (docs/multi-doctor-referrals/)
--
-- Two new concepts and nothing more:
--   care_journeys  — one "episode of care" for a patient (e.g. "Back pain").
--                    Groups every consultation that belongs to the same problem.
--   referrals      — a directed EDGE inside a journey: Dr A ──(reason)──▶ Dr B.
--                    Created by A from A's booking; "booked" once the patient
--                    books B, which links B's booking back to the edge.
--
-- Plus two nullable link columns on `bookings` (journey_id, referral_id) so the
-- patient-journey read is one indexed query, not a recursive graph walk.
--
-- All doctor FKs point at doctor_profiles.user_id (== users.id for that doctor),
-- exactly like bookings / prescriptions / clinical_notes. Patient FKs → users.id.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + information_schema-guarded ALTERs, so
-- a second `npm run migrate` is a no-op. NO `USE <db>` — the runner selects it.
-- ============================================================================

-- ── 20. CARE JOURNEYS  ==>  (1:M) patient -> many episodes of care ──────────────
CREATE TABLE IF NOT EXISTS care_journeys (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id       BIGINT UNSIGNED NOT NULL,          -- users.id
    origin_doctor_id BIGINT UNSIGNED NULL,              -- doctor who opened the episode
    origin_clinic_id BIGINT UNSIGNED NULL,              -- where it started (NULL = video)
    title            VARCHAR(200) NULL,                 -- "Back pain, Jul 2026" (editable)
    status           ENUM('open','closed') NOT NULL DEFAULT 'open',
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_care_journeys_patient (patient_id, created_at),
    CONSTRAINT fk_journey_patient FOREIGN KEY (patient_id)       REFERENCES users(id)                ON DELETE CASCADE,
    CONSTRAINT fk_journey_doctor  FOREIGN KEY (origin_doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_journey_clinic  FOREIGN KEY (origin_clinic_id) REFERENCES clinics(id)              ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── 21. REFERRALS  ==>  (M:1 journey) directed edge  Dr A ──▶ Dr B ──────────────
CREATE TABLE IF NOT EXISTS referrals (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    journey_id        BIGINT UNSIGNED NOT NULL,
    patient_id        BIGINT UNSIGNED NOT NULL,          -- users.id (denormalized for the inbox query)
    from_doctor_id    BIGINT UNSIGNED NOT NULL,          -- doctor_profiles.user_id (referrer)
    to_doctor_id      BIGINT UNSIGNED NOT NULL,          -- doctor_profiles.user_id (referee)
    source_booking_id BIGINT UNSIGNED NOT NULL,          -- A's appt where the referral was made
    target_booking_id BIGINT UNSIGNED NULL,              -- B's appt, set once the patient books B
    reason            VARCHAR(500) NOT NULL,             -- why refer (shown to patient + B)
    note              VARCHAR(1000) NULL,                -- optional extra clinical note to B
    status            ENUM('pending','booked','completed','cancelled','declined')
                        NOT NULL DEFAULT 'pending',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_referral_journey (journey_id),
    INDEX idx_referral_to_pending (to_doctor_id, status),
    INDEX idx_referral_patient (patient_id, status),
    INDEX idx_referral_source (source_booking_id),
    CONSTRAINT fk_referral_journey FOREIGN KEY (journey_id)        REFERENCES care_journeys(id)        ON DELETE CASCADE,
    CONSTRAINT fk_referral_patient FOREIGN KEY (patient_id)        REFERENCES users(id)                ON DELETE CASCADE,
    CONSTRAINT fk_referral_from    FOREIGN KEY (from_doctor_id)    REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_referral_to      FOREIGN KEY (to_doctor_id)      REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_referral_source  FOREIGN KEY (source_booking_id) REFERENCES bookings(id)             ON DELETE CASCADE,
    CONSTRAINT fk_referral_target  FOREIGN KEY (target_booking_id) REFERENCES bookings(id)             ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── bookings: +2 nullable links (guarded — safe to re-run) ──────────────────────
-- MySQL has no "ADD COLUMN IF NOT EXISTS"; guard each ALTER with information_schema
-- exactly as migration 010 does.
SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='bookings' AND column_name='journey_id');
SET @s := IF(@c=0, 'ALTER TABLE bookings ADD COLUMN journey_id BIGINT UNSIGNED NULL AFTER clinic_id', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='bookings' AND column_name='referral_id');
SET @s := IF(@c=0, 'ALTER TABLE bookings ADD COLUMN referral_id BIGINT UNSIGNED NULL AFTER journey_id', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Index on journey_id so the assembler's `WHERE journey_id = ?` is a range scan.
SET @c := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='bookings' AND index_name='idx_booking_journey');
SET @s := IF(@c=0, 'CREATE INDEX idx_booking_journey ON bookings (journey_id)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- FKs (guarded by constraint name in table_constraints).
SET @c := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='bookings' AND constraint_name='fk_booking_journey');
SET @s := IF(@c=0, 'ALTER TABLE bookings ADD CONSTRAINT fk_booking_journey FOREIGN KEY (journey_id) REFERENCES care_journeys(id) ON DELETE SET NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='bookings' AND constraint_name='fk_booking_referral');
SET @s := IF(@c=0, 'ALTER TABLE bookings ADD CONSTRAINT fk_booking_referral FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- END folded migration: 011_referrals.sql


-- ==========================================================================
-- BEGIN folded migration: 012_video_sessions.sql
-- ==========================================================================
-- ============================================================================
-- 012 — Video consultation sessions  (docs/video-consultation/)
--
-- One new table and nothing more:
--   video_sessions — the RUNTIME lifecycle of a video consult (LiveKit).
--                    0/1 per booking (UNIQUE booking_id). The booking row itself
--                    is unchanged: its reserved `meet_link` column (migration 005)
--                    is reused to hold the in-app "Join call" deep link.
--
-- The room name is deterministic ("consult-<bookingId>") and stored here only for
-- the webhook to map an inbound event back to a booking. status is driven by
-- LiveKit webhooks: pending (provisioned at payment) → live (someone joined) →
-- ended (room finished; duration recorded). The live CALL never depends on this
-- table — it is audit/attendance/"who's here" only.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, so a second `npm run migrate` is a
-- no-op. NO `USE <db>` — the runner selects the database.
-- ============================================================================

-- ── 22. VIDEO SESSIONS  ==>  (1:1 booking) the runtime lifecycle of a video consult ──
CREATE TABLE IF NOT EXISTS video_sessions (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id        BIGINT UNSIGNED NOT NULL,                    -- bookings.id (1:1)
    room_name         VARCHAR(120) NOT NULL,                       -- "consult-<bookingId>" (deterministic)
    status            ENUM('pending','live','ended') NOT NULL DEFAULT 'pending',
    started_at        DATETIME NULL,                               -- first room_started webhook
    ended_at          DATETIME NULL,                               -- room_finished webhook
    duration_sec      INT UNSIGNED NULL,                           -- ended_at - started_at (recorded, not derived)
    doctor_joined_at  DATETIME NULL,                               -- participant_joined (metadata.role = doctor)
    patient_joined_at DATETIME NULL,                               -- participant_joined (metadata.role = patient)
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_video_sessions_booking (booking_id),             -- strictly 0/1 per booking
    CONSTRAINT fk_video_session_booking FOREIGN KEY (booking_id)
        REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- END folded migration: 012_video_sessions.sql


-- ==========================================================================
-- BEGIN folded migration: 012_vitals_location.sql
-- ==========================================================================
-- ============================================================================
-- 012 — Vitals reading location  (docs/vitals-record-table/)
--
-- Adds `patient_vitals.location`: the free-text place a reading was taken
-- ("Home", "Apollo Clinic"), shown as the Location column of the record table.
--
-- Idempotent: information_schema-guarded column add (dev may already have it via
-- the boot shim db/ensureVitalsLocation.js). Safe to re-run.
--
-- NO `USE <db>` — the migration runner already selects env.DB_NAME.
-- ============================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'patient_vitals'
               AND column_name = 'location');
SET @s := IF(@c = 0,
  'ALTER TABLE patient_vitals ADD COLUMN location VARCHAR(150) NULL AFTER note',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- END folded migration: 012_vitals_location.sql


-- ==========================================================================
-- BEGIN folded migration: 013_doctor_showcase_image.sql
-- ==========================================================================
-- ============================================================================
-- 013 — Doctor showcase image
--
-- One new doctor_profiles column: the doctor-chosen picture for the
-- "Why Choose <name>" section of the public portfolio. NULL means the frontend
-- falls back to the bundled stock image (/clinic_stock.png), so existing
-- profiles keep rendering unchanged. Idempotent (guarded via
-- information_schema) like 004's column adds.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'showcase_image_url');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN showcase_image_url VARCHAR(512) NULL AFTER public_email', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 013_doctor_showcase_image.sql


-- ==========================================================================
-- BEGIN folded migration: 014_doctor_listing_toggle.sql
-- ==========================================================================
-- ============================================================================
-- 014 — Doctor listing toggle
--
-- One new doctor_profiles column: the admin's public-visibility switch. It is
-- INDEPENDENT of verification_status — an approved doctor keeps their account,
-- their bookings and their dashboard, but with is_listed = 0 they vanish from
-- every patient-facing read (discovery/find-a-doctor, the map, the portfolio
-- page, related doctors, slots and new bookings).
--
-- DEFAULT 1 so every existing approved doctor stays live after the upgrade.
-- Idempotent (guarded via information_schema) like 013's column add.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'is_listed');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN is_listed TINYINT(1) NOT NULL DEFAULT 1 AFTER is_submitted', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Discovery filters on (verification_status, is_listed) on every public list.
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND INDEX_NAME = 'idx_doctor_profiles_public');
SET @ddl := IF(@hasIdx = 0,
  'CREATE INDEX idx_doctor_profiles_public ON doctor_profiles (verification_status, is_listed)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 014_doctor_listing_toggle.sql


-- ==========================================================================
-- BEGIN folded migration: 015_prescription_duration_unit.sql
-- ==========================================================================
-- ============================================================================
-- 015 — Prescription medicine duration UNIT
--
-- `duration_days` stayed a plain number and every surface rendered it as
-- "N day(s)", so a doctor prescribing "3 months" had to write 90 and the
-- patient read "90 days". This adds the unit alongside the count; the column
-- keeps its name (the number is still the count) and DEFAULTS to 'day', so
-- every existing row means exactly what it meant before.
--
-- Idempotent (guarded via information_schema) like 013/014.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'duration_unit');
SET @ddl := IF(@has = 0,
  "ALTER TABLE prescription_items ADD COLUMN duration_unit ENUM('day','week','month') NOT NULL DEFAULT 'day' AFTER duration_days",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 015_prescription_duration_unit.sql


-- ==========================================================================
-- BEGIN folded migration: 016_booking_reschedule.sql
-- ==========================================================================
-- ============================================================================
-- 016 — Appointment reschedule audit
--
-- A doctor who can't make a slot moves the appointment rather than cancelling
-- it. These two columns record that it happened and why, so the patient sees
-- "moved from 10:00 — reason" instead of the time silently changing under them.
--
-- Both NULL for every existing row: nothing has been rescheduled yet.
-- Idempotent (guarded via information_schema) like 013/014/015.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND COLUMN_NAME = 'rescheduled_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE bookings ADD COLUMN rescheduled_at DATETIME NULL, ADD COLUMN rescheduled_reason VARCHAR(255) NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 016_booking_reschedule.sql


-- ==========================================================================
-- BEGIN folded migration: 017_clinic_role.sql
-- ==========================================================================
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

-- END folded migration: 017_clinic_role.sql


-- ==========================================================================
-- BEGIN folded migration: 018_record_provenance.sql
-- ==========================================================================
-- ============================================================================
-- 018 — Record provenance
--
-- Answers "who wrote this?" for every medical record, now that a THIRD kind of
-- author exists (the clinic portal). Two columns, added identically to five
-- tables so every record type reads the same way wherever it is displayed:
--
--   source              — 'patient' | 'doctor' | 'clinic'
--   recorded_by_user_id — the actual author, for the display name
--
-- `source` reuses the name already on patient_vitals rather than inventing a
-- parallel concept; the ENUM there is merely widened.
--
-- recorded_by_user_id is ON DELETE SET NULL, deliberately: deleting a clinic
-- account must NOT cascade-delete the medical records it wrote. The record
-- outlives its author and simply loses the attribution.
--
-- clinical_notes gets a BACKFILL (source='doctor', recorded_by = doctor_id) so
-- existing notes keep showing their doctor's name — without it, every note in
-- the system would render as authorless.
--
-- Idempotent (information_schema-guarded) like 013-017.
-- ============================================================================

-- ── patient_vitals ──────────────────────────────────────────────────────────
-- `source` already exists as ENUM('patient','doctor'); widen it in place. Every
-- existing row keeps its value.
SET @hasClinic := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'source'
    AND COLUMN_TYPE LIKE '%clinic%');
SET @ddl := IF(@hasClinic = 0,
  "ALTER TABLE patient_vitals MODIFY source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'recorded_by_user_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_vitals_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── uploaded_records ────────────────────────────────────────────────────────
-- No uploader column existed here at all before now.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE uploaded_records
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_uploaded_records_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── patient_allergies ───────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_allergies' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE patient_allergies
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_allergies_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── patient_conditions ──────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_conditions' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE patient_conditions
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'patient',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_patient_conditions_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── clinical_notes ──────────────────────────────────────────────────────────
-- doctor_id must become NULLABLE: a clinic-authored note has no doctor, and
-- doctor_id FKs doctor_profiles(user_id), which a clinic's users.id would fail.
-- The FK survives a MODIFY — MySQL permits NULL under a foreign key.
SET @isNullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_notes' AND COLUMN_NAME = 'doctor_id');
SET @ddl := IF(@isNullable = 'NO',
  'ALTER TABLE clinical_notes MODIFY doctor_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_notes' AND COLUMN_NAME = 'source');
SET @ddl := IF(@has = 0,
  "ALTER TABLE clinical_notes
     ADD COLUMN source ENUM('patient','doctor','clinic') NOT NULL DEFAULT 'doctor',
     ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_clinical_notes_recorded_by FOREIGN KEY (recorded_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- BACKFILL. Every pre-existing note was written by a doctor from a booking, so
-- the author IS doctor_id. Without this the serializer has no name to show and
-- four existing views would render "—" where a doctor's name used to be.
-- Idempotent: only touches rows not already attributed.
UPDATE clinical_notes
   SET recorded_by_user_id = doctor_id, source = 'doctor'
 WHERE recorded_by_user_id IS NULL AND doctor_id IS NOT NULL;

-- END folded migration: 018_record_provenance.sql


-- ==========================================================================
-- BEGIN folded migration: 019_booking_agency.sql
-- ==========================================================================
-- ============================================================================
-- 019 — Booking agency ("X Clinic booked this for Y patient")
--
-- One column on bookings. NULL means the patient booked it themselves, which is
-- every existing row and every row the direct patient→doctor flow will keep
-- creating — that flow is completely untouched by this feature.
--
-- ON DELETE SET NULL, not CASCADE: deleting a clinic account must never delete
-- a patient's appointment or its prescription. The booking survives and simply
-- loses the "booked by" attribution.
--
-- The doctor's appointment list reads this to show "booked by X Clinic", and the
-- patient's prescription view reads it to show "consulted Dr. A via X Clinic".
--
-- Idempotent (information_schema-guarded) like 013-018.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND COLUMN_NAME = 'booked_by_user_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE bookings
     ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL,
     ADD CONSTRAINT fk_bookings_booked_by FOREIGN KEY (booked_by_user_id)
       REFERENCES users (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- The clinic's own "appointments I booked" list filters on this.
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings' AND INDEX_NAME = 'idx_bookings_booked_by');
SET @ddl := IF(@hasIdx = 0,
  'CREATE INDEX idx_bookings_booked_by ON bookings (booked_by_user_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 019_booking_agency.sql


-- ==========================================================================
-- BEGIN folded migration: 020_no_current_medications.sql
-- ==========================================================================
-- ============================================================================
-- 020 — "No current medications" flag
--
-- One boolean on patient_profiles, completing the trio the Reported-history
-- form already had two thirds of: no_known_allergies, no_known_conditions and
-- now no_current_medications.
--
-- Why a flag rather than inferring it from an empty list: an empty medication
-- list and "I take nothing" are clinically different statements. The first
-- means nobody has asked; the second is an answer a doctor can rely on. The
-- allergies and conditions columns exist for exactly this reason — medications
-- was simply never given the same treatment.
--
-- DEFAULT 0 (false) so every existing profile keeps meaning "not answered",
-- which is what it currently means. No backfill: setting this true for every
-- patient with no medications would fabricate an answer none of them gave.
--
-- Idempotent (information_schema-guarded) like 013-019.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_profiles'
    AND COLUMN_NAME = 'no_current_medications');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_profiles
     ADD COLUMN no_current_medications TINYINT(1) NOT NULL DEFAULT 0
       AFTER no_known_conditions',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 020_no_current_medications.sql


-- ==========================================================================
-- BEGIN folded migration: 021_record_types_xray_mri.sql
-- ==========================================================================
-- ============================================================================
-- 021 — Record types: x-ray and MRI
--
-- Widens uploaded_records.file_type from 3 values to 5. The doctor's record
-- view groups a patient's documents into Prescription | Report | X-ray | MRI;
-- until now only the first two existed, so scans were inferred from the free
-- text label and a scan named anything else was silently filed as a report.
--
-- Purely additive: every existing row keeps its value, and 'other' stays for
-- anything that fits none of the four. No backfill — re-categorising existing
-- rows would guess at what a patient meant.
--
-- Idempotent (information_schema-guarded) like 013-020.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'file_type' AND COLUMN_TYPE NOT LIKE '%xray%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN file_type ENUM('prescription','lab_report','xray','mri','other')
     NOT NULL DEFAULT 'prescription'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 021_record_types_xray_mri.sql


-- ==========================================================================
-- BEGIN folded migration: 022_record_location.sql
-- ==========================================================================
-- ============================================================================
-- 022 — Where an uploaded record was produced
--
-- One nullable column on uploaded_records, mirroring patient_vitals.location
-- (migration for vitals) so "where did this happen" is asked the same way
-- everywhere in the record.
--
-- Nullable with no backfill: every existing row genuinely has no known
-- location, and inventing one would be fabricating clinical provenance.
--
-- Idempotent (information_schema-guarded) like 013-021.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'location');
SET @ddl := IF(@has = 0,
  'ALTER TABLE uploaded_records ADD COLUMN location VARCHAR(150) NULL AFTER tag',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 022_record_location.sql


-- ==========================================================================
-- BEGIN folded migration: 023_doctor_patient_status.sql
-- ==========================================================================
-- ============================================================================
-- 023 — Per-doctor patient status (My Patients categorisation)
--
-- The doctor's sketch: every patient in My Patients carries one of four
-- statuses — new patient / OPD follow-up / surgery pending / surgery follow-up.
-- New/OPD are DERIVED from visit count at read time; this table stores only
-- the doctor's manual overrides, which is why every existing roster keeps
-- working with zero rows here.
--
-- Status is per doctor↔patient PAIR, never global: the same person can be a
-- surgery follow-up for their surgeon and a new patient to a dermatologist.
--
-- ON DELETE CASCADE both ways — a status row is meaningless without either
-- party and holds no clinical data worth preserving.
--
-- Idempotent (information_schema-guarded) like 013-022.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_patient_statuses');
SET @ddl := IF(@has = 0,
  'CREATE TABLE doctor_patient_statuses (
     doctor_id  BIGINT UNSIGNED NOT NULL,
     patient_id BIGINT UNSIGNED NOT NULL,
     status ENUM(''new_patient'',''opd_followup'',''surgery_pending'',''surgery_followup'') NOT NULL,
     updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (doctor_id, patient_id),
     CONSTRAINT fk_dps_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_dps_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 023_doctor_patient_status.sql


-- ==========================================================================
-- BEGIN folded migration: 024_record_admin_source.sql
-- ==========================================================================
-- ============================================================================
-- 024 — Admin as a record author
--
-- Widens uploaded_records.source with 'admin' so the admin portal can file a
-- report on a patient's behalf under its own name, instead of masquerading as
-- a clinic or doctor. The provenance chip on every surface then tells the
-- truth about who uploaded the document.
--
-- Purely additive: every existing row keeps its value.
--
-- Idempotent (information_schema-guarded) like 013-023.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'source' AND COLUMN_TYPE NOT LIKE '%admin%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN source ENUM('patient','doctor','clinic','admin')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 024_record_admin_source.sql


-- ==========================================================================
-- BEGIN folded migration: 025_follow_up_statuses.sql
-- ==========================================================================
-- ============================================================================
-- 025 — Doctor-defined follow-up statuses (docs/follow-up-status)
--
-- Replaces the fixed ENUM in 023. A doctor owns their own list of categories:
-- they add, rename, recolour, reorder and delete them, because a surgeon's list
-- is not a dermatologist's. No code may ever branch on a label's TEXT — the
-- four seeded below are a starting list, not a fixed set, and any of them may
-- be renamed to anything or deleted outright.
--
-- Two tables:
--   follow_up_statuses  — the doctor's option list (label + colour + order)
--   patient_follow_ups  — doctor × patient → one CURRENT status + the date the
--                         patient is expected back
--
-- 023's doctor_patient_statuses is LEFT IN PLACE and unread for one release.
-- Dropping a table in the same migration that replaces it leaves no way back if
-- the backfill is wrong (verification query: docs/follow-up-status §4).
--
-- Idempotent (information_schema-guarded) like 013-024.
-- ============================================================================

-- ── 1. The doctor's own option list ─────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'follow_up_statuses');
SET @ddl := IF(@has = 0,
  'CREATE TABLE follow_up_statuses (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     doctor_id  BIGINT UNSIGNED NOT NULL,
     label      VARCHAR(40)  NOT NULL,
     color_hex  CHAR(7)      NOT NULL DEFAULT ''#2E86C1'',
     sort_order SMALLINT     NOT NULL DEFAULT 0,
     is_active  TINYINT(1)   NOT NULL DEFAULT 1,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_fus_doctor_label (doctor_id, label),
     KEY idx_fus_doctor (doctor_id, sort_order),
     CONSTRAINT fk_fus_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. The assignment ───────────────────────────────────────────────────────
-- PK (doctor_id, patient_id): ONE current status per pair, so setting it twice
-- is an upsert rather than a second row. fk_pfu_status deliberately has NO
-- CASCADE — it is what makes "a status in use cannot be deleted" a database
-- guarantee instead of a service-layer promise.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups');
SET @ddl := IF(@has = 0,
  'CREATE TABLE patient_follow_ups (
     doctor_id    BIGINT UNSIGNED NOT NULL,
     patient_id   BIGINT UNSIGNED NOT NULL,
     status_id    BIGINT UNSIGNED NOT NULL,
     follow_up_on DATE         NULL,
     note         VARCHAR(140) NULL,
     booking_id   BIGINT UNSIGNED NULL,
     updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (doctor_id, patient_id),
     KEY idx_pfu_status (status_id),
     KEY idx_pfu_due (doctor_id, follow_up_on),
     CONSTRAINT fk_pfu_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pfu_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pfu_status  FOREIGN KEY (status_id)  REFERENCES follow_up_statuses (id),
     CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. Seed every existing doctor's starting list ───────────────────────────
-- INSERT IGNORE against the (doctor_id, label) unique key, so re-running skips
-- a doctor who already has the label — including one who renamed it and made
-- their own "OPD FU" later.
INSERT IGNORE INTO follow_up_statuses (doctor_id, label, color_hex, sort_order)
SELECT u.id, seed.label, seed.color_hex, seed.sort_order
FROM users u
CROSS JOIN (
            SELECT 'NEW PATIENT' AS label, '#2E7D53' AS color_hex, 0 AS sort_order
  UNION ALL SELECT 'OPD FU',               '#2E86C1',              1
  UNION ALL SELECT 'SX WAITING',           '#B07714',              2
  UNION ALL SELECT 'SX FU',                '#5B4CB0',              3
) AS seed
WHERE u.role = 'doctor';

-- ── 4. Backfill from 023's ENUM ─────────────────────────────────────────────
INSERT IGNORE INTO patient_follow_ups (doctor_id, patient_id, status_id, follow_up_on)
SELECT dps.doctor_id, dps.patient_id, fus.id, NULL
FROM doctor_patient_statuses dps
JOIN follow_up_statuses fus
  ON fus.doctor_id = dps.doctor_id
 AND fus.label = CASE dps.status
                   WHEN 'new_patient'       THEN 'NEW PATIENT'
                   WHEN 'opd_followup'      THEN 'OPD FU'
                   WHEN 'surgery_pending'   THEN 'SX WAITING'
                   WHEN 'surgery_followup'  THEN 'SX FU'
                 END;

-- END folded migration: 025_follow_up_statuses.sql


-- ==========================================================================
-- BEGIN folded migration: 026_follow_up_per_booking.sql
-- ==========================================================================
-- ============================================================================
-- 026 — Follow-up is per CONSULTATION, not per patient (docs/follow-up-status)
--
-- 025 keyed patient_follow_ups on (doctor_id, patient_id): one current status
-- per doctor↔patient pair. That made the tag a property of the PERSON, so
-- changing it on one consultation rewrote it on every appointment that patient
-- had with that doctor — past visits included.
--
-- A follow-up is a decision made AT a consultation ("seen today, back in four
-- weeks"), so it belongs to the booking. Re-keying on booking_id lets one
-- patient carry a different status per visit and leaves history alone.
--
-- The doctor_id / patient_id columns stay: they are what the roster filters and
-- counts by, and keeping them saves a join on every list read.
--
-- Idempotent (information_schema-guarded) like 013-025.
-- ============================================================================

-- ── 1. Attach any pre-026 row to a real booking ─────────────────────────────
-- Rows written before the composer sent bookingId, plus 025's backfill from the
-- old ENUM, have booking_id NULL. Give them the doctor's most recent booking
-- with that patient — the visit the status was almost certainly set at.
UPDATE patient_follow_ups pfu
SET pfu.booking_id = (
  SELECT b.id FROM bookings b
  WHERE b.doctor_id = pfu.doctor_id AND b.patient_id = pfu.patient_id
  ORDER BY b.slot_date DESC, b.id DESC
  LIMIT 1
)
WHERE pfu.booking_id IS NULL;

-- A patient with no booking at all cannot own a per-consultation tag. There is
-- nothing to preserve — the status was unreachable from any screen.
DELETE FROM patient_follow_ups WHERE booking_id IS NULL;

-- ── 2. Re-key on the booking ────────────────────────────────────────────────
-- Two rows for one booking can't exist (the old PK allowed only one per pair),
-- so no de-duplication pass is needed before the new key goes on.
SET @pk := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups'
    AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'booking_id');

-- Split into two ALTER TABLE statements on purpose: MySQL 8 can raise
-- "Duplicate foreign key constraint name" when a DROP FOREIGN KEY and an ADD
-- CONSTRAINT of the SAME name appear together in one ALTER TABLE (the ADD's
-- name-uniqueness check runs before the DROP is applied).
SET @ddl1 := IF(@pk = 0,
  'ALTER TABLE patient_follow_ups
     DROP FOREIGN KEY fk_pfu_booking,
     MODIFY booking_id BIGINT UNSIGNED NOT NULL,
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (booking_id),
     ADD KEY idx_pfu_doctor_patient (doctor_id, patient_id)',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @ddl2 := IF(@pk = 0,
  'ALTER TABLE patient_follow_ups
     ADD CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- END folded migration: 026_follow_up_per_booking.sql


-- ==========================================================================
-- BEGIN folded migration: 027_consultation_sessions.sql
-- ==========================================================================
-- ============================================================================
-- 027 — Consultation sessions & queue tokens (docs/consultation-queue)
--
-- Replaces slot booking. A doctor publishes a consulting WINDOW per location;
-- the patient picks a clinic and a day and receives a TOKEN; the queue position
-- is derived, live, from who is still waiting.
--
-- The order below matters. The regenerated `active_lock_key` (step 5) keys on
-- (session_id, queue_number), so every live booking must already carry both —
-- which is what the backfill in step 4 does.
--
-- Idempotent and information_schema-guarded, like 013–026.
-- ============================================================================

-- ── 1. CONSULTATION SESSIONS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consultation_sessions (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    doctor_id           BIGINT UNSIGNED NOT NULL,
    clinic_id           BIGINT UNSIGNED NULL,            -- NULL = online / video
    session_date        DATE            NOT NULL,
    start_time          TIME            NOT NULL,
    end_time            TIME            NOT NULL,
    status              ENUM('scheduled','in_progress','paused','completed','cancelled')
                          NOT NULL DEFAULT 'scheduled',
    max_bookings        SMALLINT UNSIGNED NULL,          -- NULL = unlimited (the default)
    next_token          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    current_booking_id  BIGINT UNSIGNED NULL,            -- who the doctor is with RIGHT NOW
    avg_consult_minutes SMALLINT UNSIGNED NULL,          -- measured; seeds the ETA
    started_at          DATETIME NULL,
    ended_at            DATETIME NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- COALESCE, because MySQL allows unlimited NULLs in a UNIQUE index: without
    -- this, two ONLINE sessions on the same date at the same time would not
    -- collide and `resolveSession` would create a second one on every race.
    -- VIRTUAL, not STORED. Adding a STORED generated column to a table that
    -- already carries foreign keys forces a full InnoDB table COPY, which
    -- re-creates those FKs and fails on MySQL 8 with errno 1215 — the same trap
    -- db/ensureBookingLockKey.js documents for bookings.active_lock_key. MySQL 8
    -- indexes a virtual column perfectly well, so the uniqueness guard is
    -- identical; it just isn't materialised to disk.
    clinic_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(clinic_id, 0)) VIRTUAL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_session_slotless (doctor_id, session_date, clinic_key, start_time),
    KEY idx_session_doctor_date (doctor_id, session_date),
    KEY idx_session_status (status),
    CONSTRAINT fk_session_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id),
    CONSTRAINT fk_session_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: `current_booking_id` deliberately has NO foreign key. bookings.session_id
-- already points the other way, and the reverse constraint would make the pair
-- cyclic — the same hazard models/index.js documents for Booking <-> Referral.

-- ── 2. BOOKINGS — six nullable columns ──────────────────────────────────────
-- Nullable so historical rows are untouched: a booking from before this
-- migration keeps session_id NULL and renders exactly as it does today.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'bookings'
               AND column_name = 'session_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE bookings
     ADD COLUMN session_id         BIGINT UNSIGNED NULL AFTER clinic_id,
     ADD COLUMN queue_number       SMALLINT UNSIGNED NULL AFTER session_id,
     ADD COLUMN queue_state        ENUM(''waiting'',''serving'',''done'',''skipped'') NULL AFTER queue_number,
     ADD COLUMN called_at          DATETIME NULL,
     ADD COLUMN consult_started_at DATETIME NULL,
     ADD COLUMN consult_ended_at   DATETIME NULL,
     ADD KEY idx_booking_session_queue (session_id, queue_number),
     ADD CONSTRAINT fk_booking_session FOREIGN KEY (session_id) REFERENCES consultation_sessions (id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. AVAILABILITY TEMPLATES — an optional per-day cap ─────────────────────
-- `slot_duration_minutes` is KEPT and reinterpreted: it stops slicing the window
-- into bookable times and becomes the expected minutes per patient, which seeds
-- the queue ETA. Serializers expose it as `avgConsultMinutes`.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'clinic_availability'
               AND column_name = 'max_bookings');
SET @sql := IF(@col = 0,
  'ALTER TABLE clinic_availability ADD COLUMN max_bookings SMALLINT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'doctor_online_availability'
               AND column_name = 'max_bookings');
SET @sql := IF(@col = 0,
  'ALTER TABLE doctor_online_availability ADD COLUMN max_bookings SMALLINT UNSIGNED NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. BACKFILL — every LIVE booking into a session ─────────────────────────
-- Historical rows (completed / cancelled / no_show) are left alone.
--
-- One session per (doctor, clinic, date) that has a live booking. The window is
-- the min/max of what those bookings already occupy, so nobody's appointment
-- moves outside the hours they were told; step 4c then widens it to the
-- doctor's published window where one exists.
-- created_at/updated_at are named explicitly: on a dev database this table may
-- already exist from sequelize.sync(), which cannot express DEFAULT
-- CURRENT_TIMESTAMP — so CREATE TABLE IF NOT EXISTS above is a no-op and the
-- columns have no default to fall back on.
INSERT INTO consultation_sessions
    (doctor_id, clinic_id, session_date, start_time, end_time, status, next_token,
     created_at, updated_at)
SELECT b.doctor_id, b.clinic_id, b.slot_date,
       MIN(b.slot_start_time), MAX(b.slot_end_time), 'scheduled', COUNT(*) + 1,
       NOW(), NOW()
  FROM bookings b
 WHERE b.status IN ('pending_payment','confirmed') AND b.session_id IS NULL
 GROUP BY b.doctor_id, b.clinic_id, b.slot_date;

-- 4b. Attach each booking, and number them in the order the patients were
--     originally given: earliest appointment = token 1.
UPDATE bookings b
  JOIN consultation_sessions s
    ON s.doctor_id = b.doctor_id
   AND s.session_date = b.slot_date
   AND COALESCE(s.clinic_id, 0) = COALESCE(b.clinic_id, 0)
   SET b.session_id = s.id, b.queue_state = 'waiting'
 WHERE b.status IN ('pending_payment','confirmed') AND b.session_id IS NULL;

UPDATE bookings b
  JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY slot_start_time, id) AS rn
      FROM bookings
     WHERE session_id IS NOT NULL AND queue_number IS NULL
  ) t ON t.id = b.id
   SET b.queue_number = t.rn;

-- 4c. Widen each backfilled session to the doctor's real published window, so
--     the 15-minute slot span becomes the 9-to-4 the doctor actually sits.
UPDATE consultation_sessions s
  JOIN clinic_availability ca
    ON ca.clinic_id = s.clinic_id
   AND ca.day_of_week = DAYOFWEEK(s.session_date) - 1
   AND ca.is_active = 1
   SET s.start_time = LEAST(s.start_time, ca.start_time),
       s.end_time   = GREATEST(s.end_time, ca.end_time)
 WHERE s.clinic_id IS NOT NULL;

UPDATE consultation_sessions s
  JOIN doctor_online_availability oa
    ON oa.doctor_id = s.doctor_id
   AND oa.day_of_week = DAYOFWEEK(s.session_date) - 1
   AND oa.is_active = 1
   SET s.start_time = LEAST(s.start_time, oa.start_time),
       s.end_time   = GREATEST(s.end_time, oa.end_time)
 WHERE s.clinic_id IS NULL;

-- ── 5. RE-POINT THE RACE GUARD ──────────────────────────────────────────────
-- Was: CONCAT(doctor_id,'_',slot_date,'_',slot_start_time) — one patient per
-- start time, which is exactly the cap this feature removes.
-- Now:  CONCAT(session_id,'_',queue_number)                — no two patients
-- hold the same token. Still the DATABASE enforcing it; still INSERT-and-let-
-- the-loser-lose, never check-then-insert.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
               AND INDEX_NAME = 'uq_booking_doctor_slot_lock');
SET @sql := IF(@idx > 0, 'ALTER TABLE bookings DROP INDEX uq_booking_doctor_slot_lock', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'bookings'
               AND column_name = 'active_lock_key');
SET @sql := IF(@col > 0, 'ALTER TABLE bookings DROP COLUMN active_lock_key', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

ALTER TABLE bookings
  ADD COLUMN active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
      CASE WHEN status IN ('pending_payment','confirmed') AND session_id IS NOT NULL
           THEN CONCAT(session_id, '_', queue_number)
           ELSE NULL END) VIRTUAL,
  ADD UNIQUE KEY uq_booking_session_token (active_lock_key);

-- END folded migration: 027_consultation_sessions.sql


-- ==========================================================================
-- BEGIN folded migration: 028_sub_specializations.sql
-- ==========================================================================
-- ============================================================================
-- Sub-Specializations — doctor specialization → sub-specialization hierarchy
-- (docs/bugfix-05-09-2026/doctor-specialization-sub-specialization.md)
--
-- Adds a `sub_specializations` lookup table keyed to a parent specialization,
-- and a `doctor_sub_specializations` M:N junction so a doctor can list their
-- sub-specialties alongside their main specializations.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- 1. SUB_SPECIALIZATIONS lookup — each row belongs to one specialization
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sub_specializations (
    id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name              VARCHAR(150) NOT NULL,
    slug              VARCHAR(150) NOT NULL,
    specialization_id INT UNSIGNED NOT NULL,

    UNIQUE KEY uq_subspec_slug (slug),
    KEY idx_subspec_spec (specialization_id),

    CONSTRAINT fk_subspec_spec
        FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2. DOCTOR <-> SUB_SPECIALIZATION  ==>  (M:N)  junction table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_sub_specializations (
    doctor_id             BIGINT UNSIGNED NOT NULL,
    sub_specialization_id INT UNSIGNED NOT NULL,

    PRIMARY KEY (doctor_id, sub_specialization_id),

    CONSTRAINT fk_docsubspec_doctor
        FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docsubspec_subspec
        FOREIGN KEY (sub_specialization_id) REFERENCES sub_specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- END folded migration: 028_sub_specializations.sql


-- ==========================================================================
-- BEGIN folded migration: 029_follow_up_reminders.sql
-- ==========================================================================
-- ============================================================================
-- 029 — Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026)
--
-- Adds:
--   follow_up_reminders — scheduled reminders tied to a booking's follow-up
--   patient_profiles.whatsapp_opt_in — consent flag for WhatsApp messages
--
-- Idempotent (information_schema-guarded) like 013–028.
-- ============================================================================

-- ── 1. The reminder table ──────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'follow_up_reminders');
SET @ddl := IF(@has = 0,
  'CREATE TABLE follow_up_reminders (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     booking_id      BIGINT UNSIGNED NOT NULL,
     doctor_id       BIGINT UNSIGNED NOT NULL,
     patient_id      BIGINT UNSIGNED NOT NULL,
     clinic_id       BIGINT UNSIGNED NULL,
     follow_up_on    DATE         NOT NULL,
     reminder_at     DATETIME     NOT NULL,
     channel         ENUM(''email'',''whatsapp'',''both'') NOT NULL DEFAULT ''both'',
     status          ENUM(''pending'',''processing'',''sent'',''failed'',''cancelled'') NOT NULL DEFAULT ''pending'',
     email_status    ENUM(''pending'',''sent'',''failed'') NOT NULL DEFAULT ''pending'',
     whatsapp_status ENUM(''pending'',''sent'',''failed'') NOT NULL DEFAULT ''pending'',
     retry_count     TINYINT UNSIGNED NOT NULL DEFAULT 0,
     max_retries     TINYINT UNSIGNED NOT NULL DEFAULT 3,
     last_error      TEXT         NULL,
     sent_at         DATETIME     NULL,
     created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_fur_booking (booking_id),
     KEY idx_fur_doctor  (doctor_id, status),
     KEY idx_fur_patient (patient_id, status),
     KEY idx_fur_schedule (status, reminder_at),
     CONSTRAINT fk_fur_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
     CONSTRAINT fk_fur_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_fur_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_fur_clinic  FOREIGN KEY (clinic_id)  REFERENCES clinics (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. WhatsApp opt-in column on patient_profiles ──────────────────────────
SET @hasCol := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_profiles'
    AND COLUMN_NAME = 'whatsapp_opt_in');
SET @ddl2 := IF(@hasCol = 0,
  'ALTER TABLE patient_profiles
     ADD COLUMN whatsapp_opt_in TINYINT(1) NOT NULL DEFAULT 0
     AFTER no_current_medications',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- END folded migration: 029_follow_up_reminders.sql


-- ==========================================================================
-- BEGIN folded migration: 030_medicine_mr.sql
-- ==========================================================================
-- ============================================================================
-- 030 — Medicine & MR feature
--
-- Adds two new roles ('mr' and 'medicine_store') to users, plus four new
-- tables that back the medicine marketplace:
--
--   medicine_categories     — taxonomy for listing medicines
--   medicines               — individual products offered by MRs / stores
--   medicine_orders         — patient orders from providers
--   medicine_notifications  — push / in-app notifications per user
--
-- Idempotent (information_schema-guarded) like 013–029.
-- ============================================================================

-- ── 1. Widen users.role enum ───────────────────────────────────────────────
SET @hasMr := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
    AND COLUMN_TYPE LIKE '%mr%');
SET @ddl := IF(@hasMr = 0,
  "ALTER TABLE users MODIFY role ENUM('patient','doctor','admin','clinic','mr','medicine_store') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. medicine_categories ─────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_categories (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name       VARCHAR(150) NOT NULL,
     slug       VARCHAR(150) NOT NULL,
     created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mc_name (name),
     UNIQUE KEY uq_mc_slug (slug)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine_store_medicines ─────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_store_medicines (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     category_id     INT UNSIGNED    NULL,
     medicine_name   VARCHAR(255)    NOT NULL,
     generic_name    VARCHAR(255)    NULL,
     medicine_type   VARCHAR(50)     NOT NULL,
     strength        VARCHAR(100)    NULL,
     manufacturer    VARCHAR(255)    NULL,
     description     TEXT            NULL,
     price           DECIMAL(10,2)   NOT NULL,
     stock           INT UNSIGNED    NOT NULL DEFAULT 0,
     location        VARCHAR(255)    NULL,
     image_url       VARCHAR(512)    NULL,
     is_active       TINYINT(1)      NOT NULL DEFAULT 1,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_med_provider    (provider_id, provider_type),
     KEY idx_med_category    (category_id),
     KEY idx_med_active      (is_active),
     CONSTRAINT fk_med_provider  FOREIGN KEY (provider_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_med_category  FOREIGN KEY (category_id)  REFERENCES medicine_categories (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_orders ─────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_orders (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id      BIGINT UNSIGNED NOT NULL,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     medicine_id     BIGINT UNSIGNED NOT NULL,
     quantity        INT UNSIGNED    NOT NULL DEFAULT 1,
     unit_price      DECIMAL(10,2)   NOT NULL,
     total_price     DECIMAL(10,2)   NOT NULL,
     status          ENUM(''pending'',''confirmed'',''processing'',''shipped'',''delivered'',''rejected'',''cancelled'') NOT NULL DEFAULT ''pending'',
     payment_status  ENUM(''pending'',''paid'',''failed'',''refunded'') NOT NULL DEFAULT ''pending'',
     delivery_address TEXT           NULL,
     notes           TEXT            NULL,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mo_patient  (patient_id),
     KEY idx_mo_provider (provider_id, provider_type),
     KEY idx_mo_status   (status),
     CONSTRAINT fk_mo_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mo_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mo_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. medicine_notifications ──────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_notifications');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_notifications (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id         BIGINT UNSIGNED NOT NULL,
     title           VARCHAR(255)    NOT NULL,
     message         TEXT            NOT NULL,
     type            VARCHAR(50)     NOT NULL,
     reference_id    BIGINT UNSIGNED NULL,
     reference_type  VARCHAR(50)     NULL,
     is_read         TINYINT(1)      NOT NULL DEFAULT 0,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mn_user   (user_id),
     KEY idx_mn_read   (is_read),
     CONSTRAINT fk_mn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 030_medicine_mr.sql


-- ==========================================================================
-- BEGIN folded migration: 031_category_provider_owner.sql
-- ==========================================================================
-- ============================================================================
-- 031 — Category provider ownership
--
-- Adds provider_id and provider_type columns to medicine_categories so each
-- MR or Medicine Store owns their own categories. Existing global categories
-- (admin-created) remain with provider_id=NULL.
-- ============================================================================

-- Add provider_id column
SET @hasCol := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND COLUMN_NAME = 'provider_id');
SET @ddl := IF(@hasCol = 0,
  'ALTER TABLE medicine_categories ADD COLUMN provider_id BIGINT UNSIGNED NULL AFTER slug',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Add provider_type column
SET @hasCol2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND COLUMN_NAME = 'provider_type');
SET @ddl2 := IF(@hasCol2 = 0,
  "ALTER TABLE medicine_categories ADD COLUMN provider_type ENUM('mr','medicine_store') NULL AFTER provider_id",
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- Add composite unique constraint: a provider cannot have duplicate category names
SET @hasIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND INDEX_NAME = 'uq_mc_provider_name');
SET @ddl3 := IF(@hasIdx = 0,
  'ALTER TABLE medicine_categories ADD UNIQUE KEY uq_mc_provider_name (provider_id, name)',
  'SELECT 1');
PREPARE s3 FROM @ddl3; EXECUTE s3; DEALLOCATE PREPARE s3;

-- Add index for provider lookup
SET @hasIdx2 := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories' AND INDEX_NAME = 'idx_mc_provider');
SET @ddl4 := IF(@hasIdx2 = 0,
  'ALTER TABLE medicine_categories ADD INDEX idx_mc_provider (provider_id, provider_type)',
  'SELECT 1');
PREPARE s4 FROM @ddl4; EXECUTE s4; DEALLOCATE PREPARE s4;

-- END folded migration: 031_category_provider_owner.sql


-- ==========================================================================
-- BEGIN folded migration: 032_prescription_requests.sql
-- ==========================================================================
-- ============================================================================
-- 032 — Patient prescription upload & provider sharing
--
-- Adds a `prescription_requests` table so patients can upload a prescription
-- file and share it with selected medicine providers (MR / Medicine Store).
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_requests');
SET @ddl := IF(@has = 0,
  'CREATE TABLE prescription_requests (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id      BIGINT UNSIGNED NOT NULL,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     file_url        VARCHAR(512)    NOT NULL,
     file_name       VARCHAR(255)    NULL,
     notes           TEXT            NULL,
     status          ENUM(''pending'',''viewed'',''processing'',''completed'',''rejected'') NOT NULL DEFAULT ''pending'',
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_pr_patient  (patient_id),
     KEY idx_pr_provider (provider_id, provider_type),
     KEY idx_pr_status   (status),
     CONSTRAINT fk_pr_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pr_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 032_prescription_requests.sql


-- ==========================================================================
-- BEGIN folded migration: 033_prescription_availability.sql
-- ==========================================================================
-- ============================================================================
-- 033 — Prescription availability flow
--
-- Adds `prescription_request_items` (a provider's per-medicine availability
-- answer for a shared prescription) and links `medicine_orders` back to the
-- prescription request they were placed from.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_request_items');
SET @ddl := IF(@has = 0,
  'CREATE TABLE prescription_request_items (
     id                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
     prescription_request_id BIGINT UNSIGNED  NOT NULL,
     medicine_id             BIGINT UNSIGNED  NULL,
     medicine_name           VARCHAR(255)     NOT NULL,
     quantity                INT UNSIGNED     NULL,
     price                   DECIMAL(10,2)    NULL,
     status                  ENUM(''available'',''unavailable'') NOT NULL,
     reason                  VARCHAR(255)     NULL,
     created_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_pri_request (prescription_request_id),
     KEY idx_pri_status  (status),
     CONSTRAINT fk_pri_request  FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE CASCADE,
     CONSTRAINT fk_pri_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Link orders placed off a shared prescription back to that request.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'prescription_request_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE medicine_orders
     ADD COLUMN prescription_request_id BIGINT UNSIGNED NULL AFTER notes,
     ADD KEY idx_mo_prescription (prescription_request_id),
     ADD CONSTRAINT fk_mo_prescription FOREIGN KEY (prescription_request_id)
       REFERENCES prescription_requests (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 033_prescription_availability.sql


-- ==========================================================================
-- BEGIN folded migration: 034_provider_location.sql
-- ==========================================================================
-- ============================================================================
-- 034 — Structured Google location on users (MR / Medicine Store providers)
--
-- Providers are plain `users` rows (role 'mr' / 'medicine_store'), so their
-- registered location lives directly on this table, mirroring the structured
-- address columns already used by clinics / clinic_profiles:
--
--   address_line  VARCHAR(255)  street parts from the Google selection
--   city          VARCHAR(100)  locality (e.g. 'Bhubaneswar')
--   state         VARCHAR(100)  administrative_area_level_1 (e.g. 'Odisha')
--   pincode       VARCHAR(20)   postal_code
--   lat / lng     DECIMAL(10,7) Google geometry (null-island never stored)
--
-- All nullable with NO backfill: pre-existing provider registrations have no
-- Google location, and inventing coordinates/place data would be fabrication.
-- Existing rows keep NULL and only new Google-selected registrations populate
-- the columns.
--
-- Idempotent (information_schema-guarded) like 013-033.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'address_line');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN address_line VARCHAR(255) NULL AFTER profile_photo_url',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'city');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN city VARCHAR(100) NULL AFTER address_line',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'state');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN state VARCHAR(100) NULL AFTER city',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pincode');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN pincode VARCHAR(20) NULL AFTER state',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lat');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN lat DECIMAL(10,7) NULL AFTER pincode',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lng');
SET @ddl := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN lng DECIMAL(10,7) NULL AFTER lat',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 034_provider_location.sql


-- ==========================================================================
-- BEGIN folded migration: 035_medicine_master.sql
-- ==========================================================================
-- ============================================================================
-- 035 — Global medicine master + provider inventory link
--
-- Splits medicine IDENTITY from provider INVENTORY without touching existing
-- rows:
--
--   medicine_masters                      — one row per distinct medicine,
--                                           shared by every MR / Medicine Store
--   medicine_store_medicines.medicine_master_id
--                                         — each provider's inventory row
--                                           (own price + stock) points at it
--
-- Identity = normalized NAME|STRENGTH|TYPE (trimmed, whitespace-collapsed,
-- upper-cased) stored in identity_key with a UNIQUE index, so "Jerodol-SP"
-- and "JERODOL-SP" can never become two masters.
--
-- Additive only: no column is dropped, no row deleted. The column is NULLable
-- and the one-time link of pre-existing inventory rows to masters is done by
-- src/db/ensureMedicineMaster.js at boot (it uses the SAME JS normalizer as
-- the service, so the backfill and runtime can never disagree). Duplicate
-- inventory rows a provider already has are linked to the same master and
-- left in place — nothing is merged or deleted.
--
-- Idempotent (information_schema-guarded) like 013–034.
-- ============================================================================

-- ── 1. medicine_masters ──────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_masters');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_masters (
     id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     medicine_name  VARCHAR(255)    NOT NULL,
     generic_name   VARCHAR(255)    NULL,
     medicine_type  VARCHAR(50)     NOT NULL,
     strength       VARCHAR(100)    NULL,
     manufacturer   VARCHAR(255)    NULL,
     description    TEXT            NULL,
     category_id    INT UNSIGNED    NULL,
     identity_key   VARCHAR(420)    NOT NULL,
     created_by     BIGINT UNSIGNED NULL,
     is_active      TINYINT(1)      NOT NULL DEFAULT 1,
     created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mm_identity (identity_key),
     KEY idx_mm_name     (medicine_name),
     KEY idx_mm_category (category_id),
     CONSTRAINT fk_mm_category FOREIGN KEY (category_id) REFERENCES medicine_categories (id) ON DELETE SET NULL,
     CONSTRAINT fk_mm_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. medicine_store_medicines.medicine_master_id ──────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines'
    AND COLUMN_NAME = 'medicine_master_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE medicine_store_medicines
     ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER category_id,
     ADD KEY idx_msm_master (medicine_master_id),
     ADD KEY idx_msm_provider_master (provider_id, medicine_master_id),
     ADD CONSTRAINT fk_msm_master FOREIGN KEY (medicine_master_id)
       REFERENCES medicine_masters (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ----------------------------------------------------------------------------
-- Current Sequelize model: medicines (doctor's personal medicine list)
-- This table is intentionally distinct from medicine_store_medicines and
-- medicine_masters. The FK to medicine_masters is added by folded migration
-- 055 below, after medicine_masters exists.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medicines (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    doctor_id           BIGINT UNSIGNED NOT NULL,
    medicine_master_id  BIGINT UNSIGNED NULL,
    name                VARCHAR(200) NOT NULL,
    generic_name        VARCHAR(255) NULL,
    manufacturer        VARCHAR(255) NULL,
    description         TEXT NULL,
    form                VARCHAR(50) NOT NULL DEFAULT 'oral',
    strength            VARCHAR(100) NULL,
    dosage_form         VARCHAR(50) NULL,
    default_frequency   VARCHAR(100) NULL,
    default_timing      VARCHAR(20) NULL,
    category            VARCHAR(100) NULL,
    is_active           TINYINT(1) NOT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_medicines_doctor (doctor_id),
    KEY idx_medicines_master (medicine_master_id),
    CONSTRAINT fk_medicines_doctor
        FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 035_medicine_master.sql


-- ==========================================================================
-- BEGIN folded migration: 036_pharmacy_cart_orders.sql
-- ==========================================================================
-- ============================================================================
-- 036 — Pharmacy provider types + cart, order groups, billing and payment
--
-- Everything here is ADDITIVE. No column is dropped, no enum value is removed,
-- no row is deleted or rewritten. Existing MR rows keep the literal value 'mr'
-- and every foreign key stays valid; "MR is no longer active" is enforced in
-- application code (ACTIVE_MEDICINE_PROVIDER_ROLES), never by touching data.
--
--   1. users.role                       += 'pharmacy_hospital'
--   2. *.provider_type                  += 'pharmacy_hospital'   (4 tables)
--   3. medicine_orders.status           += 'on_the_way'
--   4. medicine_cart_items              — the ONE cart (patient → inventory row)
--   5. medicine_order_groups            — one checkout = one order header/bill
--   6. medicine_orders.order_group_id   — existing per-medicine rows become the
--                                         group's lines (NULL on historical rows)
--   7. medicine_payments                — the swappable payment layer
--
-- Idempotent (information_schema-guarded) like 013–035.
-- ============================================================================

-- ── 1. users.role: add the Pharmacy Hospital provider role ──────────────────
-- 'mr' is KEPT so the 13 existing MR accounts remain readable and loggable-in.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. provider_type enums ──────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_store_medicines MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_orders MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_requests'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE prescription_requests MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_categories MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine_orders.status: add ON THE WAY ───────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%on_the_way%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_orders MODIFY COLUMN status
     ENUM('pending','confirmed','processing','shipped','on_the_way','delivered','rejected','cancelled')
     NOT NULL DEFAULT 'pending'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_cart_items — the one and only cart ──────────────────────────
-- A line is (patient, provider inventory row). The inventory row already
-- carries the provider, the provider type and that provider's own price and
-- stock, so the cart can never mix one provider's medicine with another's
-- price. Nothing about money is stored here: price is read live at checkout.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_cart_items');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_cart_items (
     id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id              BIGINT UNSIGNED NOT NULL,
     medicine_id             BIGINT UNSIGNED NOT NULL,
     quantity                INT UNSIGNED    NOT NULL DEFAULT 1,
     prescription_request_id BIGINT UNSIGNED NULL,
     created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mci_patient_medicine (patient_id, medicine_id),
     KEY idx_mci_patient (patient_id),
     CONSTRAINT fk_mci_patient   FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mci_medicine  FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
     CONSTRAINT fk_mci_rx FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. medicine_order_groups — one checkout, one bill ───────────────────────
-- A checkout is split per provider, so a group is always exactly one patient
-- ordering from exactly one pharmacy. The money columns are what the BACKEND
-- computed; they are never accepted from a client. The delivery columns mirror
-- the structured Google location already on users/clinic_profiles.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups');
SET @ddl := IF(@has = 0,
  "CREATE TABLE medicine_order_groups (
     id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     order_number            VARCHAR(32)     NULL,
     patient_id              BIGINT UNSIGNED NOT NULL,
     provider_id             BIGINT UNSIGNED NOT NULL,
     provider_type           ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL,
     item_count              INT UNSIGNED    NOT NULL DEFAULT 0,
     subtotal                DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
     total_amount            DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
     payment_method          ENUM('cod','online') NOT NULL DEFAULT 'cod',
     payment_status          ENUM('pending','paid','failed','refunded') NOT NULL DEFAULT 'pending',
     status                  ENUM('pending','confirmed','processing','shipped','on_the_way','delivered','rejected','cancelled') NOT NULL DEFAULT 'pending',
     delivery_address        VARCHAR(500)    NULL,
     delivery_city           VARCHAR(100)    NULL,
     delivery_state          VARCHAR(100)    NULL,
     delivery_pincode        VARCHAR(20)     NULL,
     delivery_lat            DECIMAL(10,7)   NULL,
     delivery_lng            DECIMAL(10,7)   NULL,
     notes                   VARCHAR(500)    NULL,
     prescription_request_id BIGINT UNSIGNED NULL,
     placed_at               DATETIME        NULL,
     created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mog_number (order_number),
     KEY idx_mog_patient (patient_id),
     KEY idx_mog_provider (provider_id, status),
     CONSTRAINT fk_mog_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mog_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mog_rx FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 6. medicine_orders.order_group_id ───────────────────────────────────────
-- NULLable on purpose: the 4 pre-036 orders were placed one medicine at a time
-- and have no group. Every reader treats a NULL group as a single-line order.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'order_group_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicine_orders
     ADD COLUMN order_group_id BIGINT UNSIGNED NULL AFTER patient_id,
     ADD KEY idx_mo_group (order_group_id),
     ADD CONSTRAINT fk_mo_group FOREIGN KEY (order_group_id)
       REFERENCES medicine_order_groups (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 7. medicine_payments — the gateway-swappable payment layer ──────────────
-- One row per payment ATTEMPT on an order group. In this phase `gateway` is
-- always 'simulated' and `reference` is an obviously-synthetic SIM-… string —
-- nothing here is meant to look like a bank transaction. A real gateway later
-- adds its own gateway value plus its own id columns; orders and bills above
-- this table do not change.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments');
SET @ddl := IF(@has = 0,
  "CREATE TABLE medicine_payments (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     order_group_id  BIGINT UNSIGNED NOT NULL,
     amount          DECIMAL(10,2)   NOT NULL,
     method          ENUM('cod','online') NOT NULL,
     status          ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
     gateway         VARCHAR(30)     NOT NULL DEFAULT 'simulated',
     reference       VARCHAR(100)    NULL,
     idempotency_key VARCHAR(100)    NULL,
     failure_reason  VARCHAR(255)    NULL,
     paid_at         DATETIME        NULL,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mp_idempotency (idempotency_key),
     KEY idx_mp_group (order_group_id),
     CONSTRAINT fk_mp_group FOREIGN KEY (order_group_id)
       REFERENCES medicine_order_groups (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 036_pharmacy_cart_orders.sql


-- ==========================================================================
-- BEGIN folded migration: 037_medicine_images_substitutes.sql
-- ==========================================================================
-- ============================================================================
-- 037 — Medicine images + substitute medicines
--
-- Both hang off the GLOBAL medicine master (035), not a provider's inventory:
--
--   medicine_master_images       — up to 4 package / strip photos per medicine,
--                                  stored through the existing upload.service
--                                  (local disk or S3); sort_order 0 = primary.
--   medicine_master_substitutes  — "B substitutes for A": a self-referencing
--                                  M:N between existing masters. No medicine is
--                                  ever copied; price / stock of a substitute
--                                  come from real provider inventory rows.
--
-- Additive only: two new tables, nothing altered, dropped or deleted.
-- Idempotent (information_schema-guarded) like 013–036. The same DDL runs at
-- boot from src/db/ensureMedicineMedia.js.
-- ============================================================================

-- ── 1. medicine_master_images ───────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_master_images');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_master_images (
     id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
     medicine_master_id  BIGINT UNSIGNED   NOT NULL,
     image_url           VARCHAR(512)      NOT NULL,
     storage_key         VARCHAR(512)      NULL,
     sort_order          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
     uploaded_by         BIGINT UNSIGNED   NULL,
     created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mmi_master_order (medicine_master_id, sort_order),
     CONSTRAINT fk_mmi_master   FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mmi_uploader FOREIGN KEY (uploaded_by)        REFERENCES users (id)            ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. medicine_master_substitutes ──────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_master_substitutes');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_master_substitutes (
     id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     medicine_master_id    BIGINT UNSIGNED NOT NULL,
     substitute_master_id  BIGINT UNSIGNED NOT NULL,
     created_by            BIGINT UNSIGNED NULL,
     created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mms_pair (medicine_master_id, substitute_master_id),
     KEY idx_mms_substitute (substitute_master_id),
     CONSTRAINT fk_mms_master     FOREIGN KEY (medicine_master_id)   REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mms_substitute FOREIGN KEY (substitute_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
     CONSTRAINT fk_mms_creator    FOREIGN KEY (created_by)           REFERENCES users (id)            ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- END folded migration: 037_medicine_images_substitutes.sql


-- ==========================================================================
-- BEGIN folded migration: 038_diagnostic_lab.sql
-- ==========================================================================
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

-- END folded migration: 038_diagnostic_lab.sql


-- ==========================================================================
-- BEGIN folded migration: 039_blood_bank.sql
-- ==========================================================================
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

-- END folded migration: 039_blood_bank.sql


-- ==========================================================================
-- BEGIN folded migration: 040_ambulance.sql
-- ==========================================================================
-- ============================================================================
-- 040 — Ambulance module
--
-- Everything here is ADDITIVE: one enum value is added to users.role and new
-- ambulance_* tables are created. No existing column, row or table is changed.
--
-- Reused, not duplicated: users (the provider ACCOUNT, its address and Google
-- location from migration 034), medicine_notifications (in-app notifications,
-- shared by every provider module), the existing auth / token / role system.
--
-- Not created on purpose:
--   * ambulance_types     — types are configuration (config/ambulance.js),
--                           stored as VARCHAR so adding one needs no migration
--                           (the same decision as blood components, 039);
--   * driver user accounts — no provider module has staff sub-accounts; a
--                           driver is a record the provider manages;
--   * live GPS positions   — there is no real-time infrastructure yet. Every
--                           distance/ETA is an ESTIMATE from the ambulance's
--                           registered base location (see docs/ambulance).
--
-- Every CREATE is IF NOT EXISTS, so this file is idempotent on its own and is
-- also executed statement-by-statement by db/ensureAmbulance.js on boot.
-- ============================================================================

-- ── users.role += 'ambulance_provider' ──────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%ambulance_provider%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab','blood_bank','ambulance_provider')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- The provider / operator organisation. PK-is-the-FK on users.id, shaped after
-- blood_bank_profiles (same verification trio + is_active suspension).
CREATE TABLE IF NOT EXISTS ambulance_provider_profiles (
  user_id              BIGINT UNSIGNED NOT NULL,
  organization_name    VARCHAR(150)    NOT NULL,
  contact_person       VARCHAR(150)    NULL,
  phone                VARCHAR(20)     NULL,
  emergency_phone      VARCHAR(20)     NULL,
  district             VARCHAR(100)    NULL,
  is_24x7              TINYINT(1)      NOT NULL DEFAULT 0,
  about                VARCHAR(1000)   NULL,
  verification_status  ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  verification_notes   VARCHAR(500)    NULL,
  verified_at          DATETIME        NULL,
  is_active            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_app_verification (verification_status, is_active),
  CONSTRAINT fk_app_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Drivers are records owned by one provider (no login of their own).
CREATE TABLE IF NOT EXISTS ambulance_drivers (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id              BIGINT UNSIGNED NOT NULL,
  name                     VARCHAR(150)    NOT NULL,
  phone                    VARCHAR(20)     NOT NULL,
  license_number           VARCHAR(50)     NOT NULL,
  license_valid_until      DATE            NULL,
  emergency_contact_name   VARCHAR(150)    NULL,
  emergency_contact_phone  VARCHAR(20)     NULL,
  is_active                TINYINT(1)      NOT NULL DEFAULT 1,
  created_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ad_provider_license (provider_id, license_number),
  KEY idx_ad_provider (provider_id, is_active),
  CONSTRAINT fk_ad_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One vehicle. Publicly bookable ONLY when the provider AND this ambulance are
-- approved + active and availability_status = 'available'.
CREATE TABLE IF NOT EXISTS ambulances (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id            BIGINT UNSIGNED NOT NULL,
  registration_number    VARCHAR(30)     NOT NULL,
  vehicle_number         VARCHAR(20)     NOT NULL,
  ambulance_type         VARCHAR(40)     NOT NULL,
  vehicle_model          VARCHAR(100)    NULL,
  vehicle_details        VARCHAR(1000)   NULL,
  capacity               TINYINT UNSIGNED NULL,
  equipment              JSON            NULL,
  service_area           VARCHAR(255)    NULL,
  service_radius_km      SMALLINT UNSIGNED NULL,
  base_address           VARCHAR(255)    NULL,
  base_city              VARCHAR(100)    NULL,
  base_state             VARCHAR(100)    NULL,
  base_pincode           VARCHAR(20)     NULL,
  base_lat               DECIMAL(10,7)   NULL,
  base_lng               DECIMAL(10,7)   NULL,
  is_emergency_available TINYINT(1)      NOT NULL DEFAULT 1,
  base_fare              DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  per_km_rate            DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  waiting_charge_per_hour DECIMAL(10,2)  NULL,
  emergency_surcharge    DECIMAL(10,2)   NULL,
  default_driver_id      BIGINT UNSIGNED NULL,
  availability_status    ENUM('available','on_trip','offline','maintenance') NOT NULL DEFAULT 'available',
  verification_status    ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  verification_notes     VARCHAR(500)    NULL,
  verified_at            DATETIME        NULL,
  is_active              TINYINT(1)      NOT NULL DEFAULT 1,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_amb_registration (registration_number),
  UNIQUE KEY uq_amb_vehicle (vehicle_number),
  KEY idx_amb_provider (provider_id, verification_status),
  KEY idx_amb_public (verification_status, is_active, availability_status, ambulance_type),
  KEY idx_amb_location (base_lat, base_lng),
  KEY idx_amb_city (base_city, base_state),
  CONSTRAINT fk_amb_provider FOREIGN KEY (provider_id)       REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_amb_driver   FOREIGN KEY (default_driver_id) REFERENCES ambulance_drivers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A patient's booking of one ambulance. Fare inputs are SNAPSHOTS taken at
-- booking time, so a later price change never rewrites an existing booking.
CREATE TABLE IF NOT EXISTS ambulance_bookings (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_code           VARCHAR(24)     NOT NULL,
  patient_id             BIGINT UNSIGNED NOT NULL,
  provider_id            BIGINT UNSIGNED NOT NULL,
  ambulance_id           BIGINT UNSIGNED NOT NULL,
  driver_id              BIGINT UNSIGNED NULL,
  ambulance_type         VARCHAR(40)     NOT NULL,
  is_emergency           TINYINT(1)      NOT NULL DEFAULT 0,
  patient_name           VARCHAR(150)    NOT NULL,
  contact_phone          VARCHAR(20)     NOT NULL,
  pickup_address         VARCHAR(255)    NOT NULL,
  pickup_lat             DECIMAL(10,7)   NOT NULL,
  pickup_lng             DECIMAL(10,7)   NOT NULL,
  drop_address           VARCHAR(255)    NOT NULL,
  drop_lat               DECIMAL(10,7)   NOT NULL,
  drop_lng               DECIMAL(10,7)   NOT NULL,
  notes                  VARCHAR(1000)   NULL,
  estimated_distance_km  DECIMAL(8,2)    NOT NULL,
  base_fare              DECIMAL(10,2)   NOT NULL,
  per_km_rate            DECIMAL(10,2)   NOT NULL,
  emergency_surcharge    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  waiting_charge_per_hour DECIMAL(10,2)  NULL,
  estimated_fare         DECIMAL(10,2)   NOT NULL,
  actual_distance_km     DECIMAL(8,2)    NULL,
  waiting_minutes        SMALLINT UNSIGNED NULL,
  final_fare             DECIMAL(10,2)   NULL,
  eta_minutes            SMALLINT UNSIGNED NULL,
  status                 ENUM('requested','accepted','driver_assigned','en_route','arrived','patient_picked_up','completed','rejected','cancelled') NOT NULL DEFAULT 'requested',
  provider_note          VARCHAR(500)    NULL,
  cancel_reason          VARCHAR(500)    NULL,
  cancelled_by           ENUM('patient','provider','admin') NULL,
  accepted_at            DATETIME        NULL,
  driver_assigned_at     DATETIME        NULL,
  en_route_at            DATETIME        NULL,
  arrived_at             DATETIME        NULL,
  picked_up_at           DATETIME        NULL,
  completed_at           DATETIME        NULL,
  rejected_at            DATETIME        NULL,
  cancelled_at           DATETIME        NULL,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ab_code (booking_code),
  KEY idx_ab_patient (patient_id, created_at),
  KEY idx_ab_provider (provider_id, status, created_at),
  KEY idx_ab_ambulance (ambulance_id, status),
  KEY idx_ab_driver (driver_id, status),
  KEY idx_ab_status (status, created_at),
  CONSTRAINT fk_ab_patient   FOREIGN KEY (patient_id)   REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_ab_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_ab_ambulance FOREIGN KEY (ambulance_id) REFERENCES ambulances (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ab_driver    FOREIGN KEY (driver_id)    REFERENCES ambulance_drivers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The status history (timeline + audit): one row per transition, written in
-- the SAME transaction as the status change.
CREATE TABLE IF NOT EXISTS ambulance_booking_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id      BIGINT UNSIGNED NOT NULL,
  from_status     VARCHAR(30)     NULL,
  to_status       VARCHAR(30)     NOT NULL,
  actor_user_id   BIGINT UNSIGNED NULL,
  actor_role      ENUM('patient','provider','admin') NOT NULL,
  note            VARCHAR(500)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_abe_booking (booking_id, created_at),
  CONSTRAINT fk_abe_booking FOREIGN KEY (booking_id)    REFERENCES ambulance_bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_abe_actor   FOREIGN KEY (actor_user_id) REFERENCES users (id)              ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 040_ambulance.sql


-- ==========================================================================
-- BEGIN folded migration: 043_pharmacy_management.sql
-- ==========================================================================
-- ============================================================================
-- 043 — Pharmacy management: pricing/GST on inventory, batches + expiry,
--       stock ledger, suppliers, purchases, returns / credit notes, settings
--
-- Builds on the EXISTING medicine architecture without duplicating it:
--
--   medicine_store_medicines   (inventory)  += sku, hsn, pack, MRP, buying
--                                              price, GST %, discount %,
--                                              reorder level, nearest-expiry
--                                              batch summary, last supplier
--   medicine_orders            (order lines) += price / discount / GST / cost
--                                              snapshot at the time of sale
--   medicine_order_groups      (the bill)    += discount and GST totals
--
--   pharmacy_suppliers         — a pharmacy's own suppliers
--   medicine_stock_batches     — batch-wise stock of one inventory row
--   pharmacy_purchases / _items— supplier purchase invoices (stock IN)
--   medicine_returns / _items  — returns against delivered orders (credit notes)
--   medicine_stock_movements   — the stock ledger: every change, with its cause
--   pharmacy_profiles          — GSTIN / drug licence / expiry window per pharmacy
--
-- Invariant kept by services/pharmacyStock.service.js:
--   inventory.stock = Σ batch.quantity_available + untracked (pre-batch) units
--
-- ADDITIVE ONLY: nothing is dropped, renamed or narrowed; no row is deleted
-- or rewritten. Existing inventory rows get GST 0, discount 0 and reorder
-- level 10 (the admin tracker's existing low-stock figure) until edited.
--
-- Numbering: 041 / 042 are not in this branch on purpose. Development
-- databases already recorded `041_home_care.sql` (another branch) and an
-- earlier draft `042_pharmacy_management.sql` in _migrations; re-using either
-- id would make `npm run migrate` silently skip this file there. The columns
-- the 042 draft created without are reconciled by the guarded ALTERs below.
--
-- Idempotent (IF NOT EXISTS + information_schema-guarded) like 013–040. The
-- same DDL runs at boot from src/db/ensurePharmacyManagement.js, which reads
-- the CREATE TABLE statements straight out of this file.
-- ============================================================================

-- ── 1. pharmacy_suppliers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pharmacy_suppliers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id    BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(200)    NOT NULL,
  contact_person VARCHAR(150)    NULL,
  phone          VARCHAR(20)     NULL,
  email          VARCHAR(255)    NULL,
  address        VARCHAR(500)    NULL,
  gstin          VARCHAR(15)     NULL,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ps_provider_name (provider_id, name),
  CONSTRAINT fk_ps_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. medicine_stock_batches ───────────────────────────────────────────────
-- One row per (inventory row, batch number). The collation is case-insensitive
-- and the service upper-cases batch numbers, so "b12" and "B12" are one batch.
CREATE TABLE IF NOT EXISTS medicine_stock_batches (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id        BIGINT UNSIGNED NOT NULL,
  inventory_id       BIGINT UNSIGNED NOT NULL,
  batch_number       VARCHAR(64)     NOT NULL,
  expiry_date        DATE            NULL,
  quantity_received  INT UNSIGNED    NOT NULL DEFAULT 0,
  quantity_available INT UNSIGNED    NOT NULL DEFAULT 0,
  buying_price       DECIMAL(10,2)   NULL,
  mrp                DECIMAL(10,2)   NULL,
  supplier_id        BIGINT UNSIGNED NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_msb_inventory_batch (inventory_id, batch_number),
  KEY idx_msb_provider_expiry (provider_id, expiry_date),
  KEY idx_msb_supplier (supplier_id),
  CONSTRAINT fk_msb_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)                    ON DELETE CASCADE,
  CONSTRAINT fk_msb_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
  CONSTRAINT fk_msb_supplier  FOREIGN KEY (supplier_id)  REFERENCES pharmacy_suppliers (id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. pharmacy_purchases — one supplier invoice ────────────────────────────
-- Money columns are what the BACKEND computed from the lines; never client totals.
CREATE TABLE IF NOT EXISTS pharmacy_purchases (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_number VARCHAR(32)     NULL,
  provider_id     BIGINT UNSIGNED NOT NULL,
  supplier_id     BIGINT UNSIGNED NULL,
  invoice_number  VARCHAR(64)     NOT NULL,
  invoice_date    DATE            NOT NULL,
  status          ENUM('received','cancelled') NOT NULL DEFAULT 'received',
  cancelled_at    DATETIME        NULL,
  item_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  subtotal        DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  discount_total  DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  taxable_total   DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  gst_total       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  total_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  notes           VARCHAR(500)    NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pp_number (purchase_number),
  KEY idx_pp_provider_date (provider_id, invoice_date),
  KEY idx_pp_supplier (supplier_id),
  CONSTRAINT fk_pp_provider FOREIGN KEY (provider_id) REFERENCES users (id)              ON DELETE CASCADE,
  CONSTRAINT fk_pp_supplier FOREIGN KEY (supplier_id) REFERENCES pharmacy_suppliers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. pharmacy_purchase_items — one medicine line on a purchase ────────────
CREATE TABLE IF NOT EXISTS pharmacy_purchase_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_id        BIGINT UNSIGNED NOT NULL,
  inventory_id       BIGINT UNSIGNED NULL,
  batch_id           BIGINT UNSIGNED NULL,
  medicine_master_id BIGINT UNSIGNED NULL,
  medicine_name      VARCHAR(255)    NOT NULL,
  batch_number       VARCHAR(64)     NULL,
  expiry_date        DATE            NULL,
  quantity           INT UNSIGNED    NOT NULL,
  free_quantity      INT UNSIGNED    NOT NULL DEFAULT 0,
  buying_price       DECIMAL(10,2)   NOT NULL,
  mrp                DECIMAL(10,2)   NULL,
  selling_price      DECIMAL(10,2)   NULL,
  gst_rate           DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  discount_percent   DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  gross_amount       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  discount_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  taxable_amount     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  gst_amount         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  line_total         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ppi_purchase (purchase_id),
  KEY idx_ppi_inventory (inventory_id),
  KEY idx_ppi_batch (batch_id),
  CONSTRAINT fk_ppi_purchase  FOREIGN KEY (purchase_id)  REFERENCES pharmacy_purchases (id)       ON DELETE CASCADE,
  CONSTRAINT fk_ppi_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE SET NULL,
  CONSTRAINT fk_ppi_batch     FOREIGN KEY (batch_id)     REFERENCES medicine_stock_batches (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. medicine_returns — a credit note against one delivered order ─────────
CREATE TABLE IF NOT EXISTS medicine_returns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_note_number VARCHAR(32)     NULL,
  order_group_id     BIGINT UNSIGNED NOT NULL,
  provider_id        BIGINT UNSIGNED NOT NULL,
  patient_id         BIGINT UNSIGNED NOT NULL,
  reason             VARCHAR(500)    NULL,
  restocked          TINYINT(1)      NOT NULL DEFAULT 1,
  item_count         INT UNSIGNED    NOT NULL DEFAULT 0,
  taxable_total      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  gst_total          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  refund_amount      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mr_credit_note (credit_note_number),
  KEY idx_mr_provider_date (provider_id, created_at),
  KEY idx_mr_group (order_group_id),
  CONSTRAINT fk_mr_group    FOREIGN KEY (order_group_id) REFERENCES medicine_order_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_mr_provider FOREIGN KEY (provider_id)    REFERENCES users (id)                 ON DELETE CASCADE,
  CONSTRAINT fk_mr_patient  FOREIGN KEY (patient_id)     REFERENCES users (id)                 ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6. medicine_return_items — returned quantity of one order line ──────────
CREATE TABLE IF NOT EXISTS medicine_return_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id      BIGINT UNSIGNED NOT NULL,
  order_line_id  BIGINT UNSIGNED NOT NULL,
  medicine_id    BIGINT UNSIGNED NULL,
  medicine_name  VARCHAR(255)    NOT NULL,
  quantity       INT UNSIGNED    NOT NULL,
  unit_price     DECIMAL(10,2)   NOT NULL,
  gst_rate       DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  taxable_amount DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  gst_amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  line_total     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mri_return (return_id),
  KEY idx_mri_line (order_line_id),
  CONSTRAINT fk_mri_return   FOREIGN KEY (return_id)     REFERENCES medicine_returns (id)         ON DELETE CASCADE,
  CONSTRAINT fk_mri_line     FOREIGN KEY (order_line_id) REFERENCES medicine_orders (id)          ON DELETE CASCADE,
  CONSTRAINT fk_mri_medicine FOREIGN KEY (medicine_id)   REFERENCES medicine_store_medicines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 7. medicine_stock_movements — the stock ledger ──────────────────────────
-- Signed quantity (+in / −out) and the stock level right after it. A sale's
-- rows also record WHICH batch each unit came from, which is how a cancel or a
-- return puts units back on exactly the batch they left.
CREATE TABLE IF NOT EXISTS medicine_stock_movements (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id    BIGINT UNSIGNED NOT NULL,
  inventory_id   BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,
  movement_type  ENUM('opening','purchase','purchase_cancel','sale','sale_reversal','return','adjustment','import','expiry_writeoff') NOT NULL,
  quantity       INT             NOT NULL,
  stock_after    INT UNSIGNED    NOT NULL,
  reference_type VARCHAR(30)     NULL,
  reference_id   BIGINT UNSIGNED NULL,
  note           VARCHAR(255)    NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_msmv_inventory (inventory_id, created_at),
  KEY idx_msmv_reference (reference_type, reference_id),
  KEY idx_msmv_provider (provider_id, created_at),
  KEY idx_msmv_batch (batch_id),
  CONSTRAINT fk_msmv_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)                    ON DELETE CASCADE,
  CONSTRAINT fk_msmv_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
  CONSTRAINT fk_msmv_batch     FOREIGN KEY (batch_id)     REFERENCES medicine_stock_batches (id)   ON DELETE SET NULL,
  CONSTRAINT fk_msmv_creator   FOREIGN KEY (created_by)   REFERENCES users (id)                    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 8. pharmacy_profiles — the store's tax / licence details + preferences ──
CREATE TABLE IF NOT EXISTS pharmacy_profiles (
  provider_id         BIGINT UNSIGNED   NOT NULL,
  gstin               VARCHAR(15)       NULL,
  drug_license_number VARCHAR(64)       NULL,
  expiry_alert_days   SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  invoice_note        VARCHAR(500)      NULL,
  created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_id),
  CONSTRAINT fk_pprof_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 9. Columns on existing tables ───────────────────────────────────────────
-- (A table created above already has them; these only fire on older tables.)

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'sku');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN sku VARCHAR(64) NULL AFTER medicine_master_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'hsn_code');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN hsn_code VARCHAR(20) NULL AFTER description', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'pack_size');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN pack_size VARCHAR(50) NULL AFTER hsn_code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'mrp');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN mrp DECIMAL(10,2) NULL AFTER pack_size', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'buying_price');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN buying_price DECIMAL(10,2) NULL AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'gst_rate');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER price', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'discount_percent');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER gst_rate', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'min_stock');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN min_stock INT UNSIGNED NOT NULL DEFAULT 10 AFTER stock', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'batch_number');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN batch_number VARCHAR(64) NULL AFTER min_stock', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'expiry_date');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN expiry_date DATE NULL AFTER batch_number', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'supplier_id');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN supplier_id BIGINT UNSIGNED NULL AFTER expiry_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'mrp');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN mrp DECIMAL(10,2) NULL AFTER unit_price', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'discount_percent');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'discount_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_percent', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'gst_rate');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER discount_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'taxable_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN taxable_amount DECIMAL(10,2) NULL AFTER gst_rate', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'gst_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN gst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'unit_cost');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN unit_cost DECIMAL(10,2) NULL AFTER gst_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'hsn_code');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN hsn_code VARCHAR(20) NULL AFTER unit_cost', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'batch_number');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN batch_number VARCHAR(64) NULL AFTER hsn_code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'expiry_date');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN expiry_date DATE NULL AFTER batch_number', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'discount_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN discount_total DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER subtotal', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'taxable_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN taxable_total DECIMAL(10,2) NULL AFTER discount_total', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'gst_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN gst_total DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_total', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchases' AND COLUMN_NAME = 'status');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchases ADD COLUMN status ENUM(''received'',''cancelled'') NOT NULL DEFAULT ''received'' AFTER invoice_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchases' AND COLUMN_NAME = 'cancelled_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchases ADD COLUMN cancelled_at DATETIME NULL AFTER status', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND COLUMN_NAME = 'batch_id');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD COLUMN batch_id BIGINT UNSIGNED NULL AFTER inventory_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND COLUMN_NAME = 'selling_price');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD COLUMN selling_price DECIMAL(10,2) NULL AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 10. Indexes ──────────────────────────────────────────────────────────────

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_provider_active');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_provider_active (provider_id, is_active)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_provider_expiry');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_provider_expiry (provider_id, expiry_date)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_supplier');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_supplier (supplier_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND INDEX_NAME = 'idx_mog_provider_placed');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD INDEX idx_mog_provider_placed (provider_id, placed_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND INDEX_NAME = 'idx_ppi_batch');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD INDEX idx_ppi_batch (batch_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 11. Foreign keys ─────────────────────────────────────────────────────────

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND CONSTRAINT_NAME = 'fk_msm_supplier');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD CONSTRAINT fk_msm_supplier FOREIGN KEY (supplier_id) REFERENCES pharmacy_suppliers (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND CONSTRAINT_NAME = 'fk_ppi_batch');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD CONSTRAINT fk_ppi_batch FOREIGN KEY (batch_id) REFERENCES medicine_stock_batches (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 043_pharmacy_management.sql


-- ==========================================================================
-- BEGIN folded migration: 044_provider_payment_qr.sql
-- ==========================================================================
-- ============================================================================
-- 044 — Provider UPI QR payments
--
-- A doctor or a pharmacy uploads its OWN UPI QR code; a patient pays it from
-- any UPI app and may report "I have paid" with the UPI transaction id. The
-- platform never treats that as proof: the payment stays pending until the
-- PROVIDER confirms the money reached them (doctor: the existing mark-paid;
-- pharmacy: confirm-received). No gateway, no money through the platform.
--
--   provider_payment_qr   — one row per provider user: QR image URL, UPI id,
--                           payee name, active flag
--   payments              += offline_method ('cash' | 'upi_qr'),
--                            payer_reference, payer_reported_at
--   medicine_order_groups.payment_method += 'upi_qr'
--   medicine_payments.method             += 'upi_qr'
--   medicine_payments     += payer_reference, payer_reported_at
--   (medicine_payments.gateway is a VARCHAR — 'manual_upi' needs no DDL)
--
-- ADDITIVE ONLY: no column is dropped, renamed or narrowed; the two ENUMs are
-- widened with a NEW trailing value (every existing value and the default are
-- kept), so no existing row changes. Existing offline booking payments keep
-- offline_method NULL, which every reader treats as cash.
--
-- Idempotent (IF NOT EXISTS + information_schema-guarded) like 043. The same
-- DDL runs at boot from src/db/ensurePaymentQr.js, which reads the CREATE
-- TABLE statement straight out of this file.
-- ============================================================================

-- ── 1. provider_payment_qr ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_payment_qr (
  user_id      BIGINT UNSIGNED NOT NULL,
  qr_image_url VARCHAR(500)    NULL,
  upi_id       VARCHAR(100)    NULL,
  payee_name   VARCHAR(150)    NULL,
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_ppq_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. payments (doctor bookings) ───────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'offline_method');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN offline_method ENUM(''cash'',''upi_qr'') NULL AFTER mode', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'payer_reference');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN payer_reference VARCHAR(64) NULL AFTER offline_method', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'payer_reported_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN payer_reported_at DATETIME NULL AFTER payer_reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine orders: widen the payment-method enums with 'upi_qr' ────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'payment_method'
    AND COLUMN_TYPE NOT LIKE '%''upi_qr''%');
SET @ddl := IF(@has = 1, 'ALTER TABLE medicine_order_groups MODIFY COLUMN payment_method ENUM(''cod'',''online'',''upi_qr'') NOT NULL DEFAULT ''cod''', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'method'
    AND COLUMN_TYPE NOT LIKE '%''upi_qr''%');
SET @ddl := IF(@has = 1, 'ALTER TABLE medicine_payments MODIFY COLUMN method ENUM(''cod'',''online'',''upi_qr'') NOT NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_payments: what the patient reported ─────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'payer_reference');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_payments ADD COLUMN payer_reference VARCHAR(64) NULL AFTER reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'payer_reported_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_payments ADD COLUMN payer_reported_at DATETIME NULL AFTER payer_reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 044_provider_payment_qr.sql


-- ==========================================================================
-- BEGIN folded migration: 045_doctor_record_access.sql
-- ==========================================================================
-- 045: Doctor record-access consent + access audit log.
--
-- A doctor who does NOT already treat a patient (no confirmed/completed
-- booking — the existing rule, unchanged) may ask the patient for ONE category
-- of their uploaded records. The patient approves by choosing the exact
-- documents to share; the grant covers only those rows, expires, and can be
-- revoked. Every request, decision, revocation and file download is written to
-- the append-only access_audit_logs table.
--
-- ADDITIVE ONLY: three new tables. No existing table, column or row is changed.
-- Applied by `npm run migrate` and, idempotently, by db/ensureDoctorRecordAccess.js
-- on every boot.

CREATE TABLE IF NOT EXISTS doctor_access_requests (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id          BIGINT UNSIGNED NOT NULL,
  patient_id         BIGINT UNSIGNED NOT NULL,
  category           ENUM('prescription','lab_report','xray','mri','other') NOT NULL,
  purpose            VARCHAR(500) NOT NULL,
  status             ENUM('pending','approved','rejected','revoked','expired','cancelled') NOT NULL DEFAULT 'pending',
  request_expires_at DATETIME NOT NULL,
  decided_at         DATETIME NULL,
  decision_note      VARCHAR(500) NULL,
  grant_expires_at   DATETIME NULL,
  revoked_at         DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dar_doctor_patient (doctor_id, patient_id, status),
  KEY idx_dar_patient_status (patient_id, status),
  CONSTRAINT fk_dar_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_dar_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doctor_access_grant_items (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id  BIGINT UNSIGNED NOT NULL,
  record_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dagi_request_record (request_id, record_id),
  KEY idx_dagi_record (record_id),
  CONSTRAINT fk_dagi_request FOREIGN KEY (request_id) REFERENCES doctor_access_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_dagi_record FOREIGN KEY (record_id) REFERENCES uploaded_records (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id  BIGINT UNSIGNED NULL,
  actor_role     VARCHAR(30) NULL,
  action         VARCHAR(50) NOT NULL,
  doctor_id      BIGINT UNSIGNED NULL,
  patient_id     BIGINT UNSIGNED NULL,
  entity_type    VARCHAR(50) NULL,
  entity_id      BIGINT UNSIGNED NULL,
  details        JSON NULL,
  ip             VARCHAR(64) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_aal_patient (patient_id, created_at),
  KEY idx_aal_doctor (doctor_id, created_at),
  KEY idx_aal_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 045_doctor_record_access.sql


-- ==========================================================================
-- BEGIN folded migration: 046_doctor_hero_images.sql
-- ==========================================================================
-- ============================================================================
-- 046 — Doctor portfolio hero images
--
-- One new doctor_profiles column: up to three doctor-uploaded background
-- pictures for the public portfolio hero, stored as a JSON array of URLs in
-- display order (["https://…", "https://…"]). NULL or [] means "no images" and
-- the frontends render the plain hero, so existing profiles are unchanged.
-- The three-image cap is enforced by the API (doctor.service). Idempotent
-- (guarded via information_schema) like 013's column add.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_profiles' AND COLUMN_NAME = 'hero_image_urls');
SET @ddl := IF(@has = 0,
  'ALTER TABLE doctor_profiles ADD COLUMN hero_image_urls JSON NULL AFTER showcase_image_url', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 046_doctor_hero_images.sql


-- ==========================================================================
-- BEGIN folded migration: 047_clinic_optional_coordinates.sql
-- ==========================================================================
-- ============================================================================
-- 047 — Clinic coordinates become optional
--
-- A doctor must be able to save a clinic by typing its address, with or
-- without a Google Maps pin. clinics.lat / clinics.lng were NOT NULL, which
-- forced a map pick. This only RELAXES the constraint: every existing row keeps
-- its coordinates, nothing is rewritten, and readers already treat a missing
-- pin as "no location" (doctor search filters `c.lat IS NOT NULL`, the public
-- serializer sends 0/0, which every client already reads as "not pinned").
-- Idempotent: each MODIFY runs only while the column is still NOT NULL.
-- ============================================================================

SET @lat_required := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'lat' AND IS_NULLABLE = 'NO');
SET @ddl := IF(@lat_required > 0,
  'ALTER TABLE clinics MODIFY COLUMN lat DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @lng_required := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'lng' AND IS_NULLABLE = 'NO');
SET @ddl := IF(@lng_required > 0,
  'ALTER TABLE clinics MODIFY COLUMN lng DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 047_clinic_optional_coordinates.sql


-- ==========================================================================
-- BEGIN folded migration: 048_doctor_award_images_testimonials.sql
-- ==========================================================================
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

-- END folded migration: 048_doctor_award_images_testimonials.sql


-- ==========================================================================
-- BEGIN folded migration: 049_doctor_portfolio_sections.sql
-- ==========================================================================
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

-- END folded migration: 049_doctor_portfolio_sections.sql


-- ==========================================================================
-- BEGIN folded migration: 050_password_reset_otps.sql
-- ==========================================================================
-- ============================================================================
-- 050 — Password reset by mobile OTP
--
-- A patient who forgot their password can prove they own their registered
-- mobile number with a 6-digit SMS code. A verified code is exchanged for a
-- normal single-use password_reset_tokens row, so the actual password change
-- still goes through the existing POST /auth/reset-password (same hashing, same
-- "revoke every session" behaviour).
--
--   password_reset_otps — one row per code sent: HMAC of the code (never the
--                         code), the canonical 10-digit phone, attempt counter,
--                         expiry, consumed flag.
--
-- ADDITIVE ONLY: a new table; nothing existing is altered. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED  NULL,
  phone       VARCHAR(10)      NOT NULL,
  code_hash   CHAR(64)         NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME         NOT NULL,
  consumed_at DATETIME         NULL,
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pro_phone_created (phone, created_at),
  CONSTRAINT fk_pro_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 050_password_reset_otps.sql


-- ==========================================================================
-- BEGIN folded migration: 051_emr_clinical_workspace.sql
-- ==========================================================================
-- ============================================================================
-- 051 — Doctor EMR workspace (structured consultation records)
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped; every new column is
-- NULLable (or has a default), so existing rows and existing clients keep
-- working unchanged. No booking / registration / login table is touched — the
-- "encounter" is still the existing booking.
--
--   patient_vitals       + recorded_at (time of reading), booking_id (the visit
--                          it was taken in), bp_systolic, bp_diastolic,
--                          heart_rate_bpm, respiratory_rate, waist_cm, hip_cm,
--                          head_circumference_cm. The legacy blood_pressure
--                          string is still written ("120/80") so every older
--                          view keeps working. BMI and waist-hip ratio stay
--                          DERIVED (never stored), like BMI already was.
--   patient_follow_ups   + interval_value, interval_unit, home_care,
--                          service_name, service_quantity, comments
--   prescription_items   + quantity, priority, name_type (trade | generic)
--   prescriptions        + no_medication (doctor ticked "medication not needed")
--
--   NEW clinical_entries — one row per structured consultation entry: chief
--                          complaint, history, comorbidity, examination,
--                          diagnosis, investigation order, doctor's note.
--                          Never hard-deleted: a wrong entry is retired with
--                          status 'entered_in_error' + a reason, so the record
--                          history is preserved.
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureEmrWorkspace.js
-- on every dev boot.
-- ============================================================================

-- ── New columns on existing tables (each guarded, so re-running is a no-op) ──
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'recorded_at');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN recorded_at DATETIME NULL AFTER recorded_on', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'booking_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN booking_id BIGINT UNSIGNED NULL AFTER patient_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'bp_systolic');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN bp_systolic SMALLINT UNSIGNED NULL AFTER blood_pressure', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'bp_diastolic');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN bp_diastolic SMALLINT UNSIGNED NULL AFTER bp_systolic', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'heart_rate_bpm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN heart_rate_bpm SMALLINT UNSIGNED NULL AFTER pulse_rate_bpm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'respiratory_rate');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN respiratory_rate SMALLINT UNSIGNED NULL AFTER heart_rate_bpm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'waist_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN waist_cm DECIMAL(5,1) NULL AFTER height_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'hip_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN hip_cm DECIMAL(5,1) NULL AFTER waist_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND COLUMN_NAME = 'head_circumference_cm');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD COLUMN head_circumference_cm DECIMAL(5,1) NULL AFTER hip_cm', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_vitals' AND INDEX_NAME = 'idx_pv_booking');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_vitals ADD INDEX idx_pv_booking (booking_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'interval_value');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN interval_value SMALLINT UNSIGNED NULL AFTER follow_up_on', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'interval_unit');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN interval_unit ENUM(''day'',''week'',''month'') NULL AFTER interval_value', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'home_care');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN home_care TINYINT(1) NOT NULL DEFAULT 0 AFTER interval_unit', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'service_name');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN service_name VARCHAR(150) NULL AFTER home_care', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'service_quantity');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN service_quantity SMALLINT UNSIGNED NULL AFTER service_name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups' AND COLUMN_NAME = 'comments');
SET @ddl := IF(@has = 0,
  'ALTER TABLE patient_follow_ups ADD COLUMN comments VARCHAR(1000) NULL AFTER service_quantity', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'quantity');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN quantity SMALLINT UNSIGNED NULL AFTER duration_unit', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'priority');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN priority ENUM(''routine'',''urgent'',''stat'') NULL AFTER quantity', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'name_type');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN name_type ENUM(''trade'',''generic'') NULL AFTER priority', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescriptions' AND COLUMN_NAME = 'no_medication');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescriptions ADD COLUMN no_medication TINYINT(1) NOT NULL DEFAULT 0 AFTER follow_up_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Structured consultation entries ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_entries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id      BIGINT UNSIGNED NOT NULL,
  doctor_id       BIGINT UNSIGNED NULL,
  booking_id      BIGINT UNSIGNED NULL,
  kind            ENUM('complaint','history','comorbidity','examination','diagnosis','investigation','doctor_note') NOT NULL,
  category        VARCHAR(60)     NULL,
  title           VARCHAR(255)    NULL,
  code            VARCHAR(20)     NULL,
  details         JSON            NULL,
  remarks         TEXT            NULL,
  recorded_on     DATE            NULL,
  patient_visible TINYINT(1)      NOT NULL DEFAULT 1,
  status          ENUM('active','entered_in_error') NOT NULL DEFAULT 'active',
  retired_reason  VARCHAR(255)    NULL,
  created_by      BIGINT UNSIGNED NULL,
  updated_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ce_patient_kind (patient_id, kind, created_at),
  KEY idx_ce_booking (booking_id),
  KEY idx_ce_doctor (doctor_id, created_at),
  CONSTRAINT fk_ce_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ce_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ce_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 051_emr_clinical_workspace.sql


-- ==========================================================================
-- BEGIN folded migration: 052_password_reset_email_otp.sql
-- ==========================================================================
-- ============================================================================
-- 052 — Password reset OTP by EMAIL (extends 050)
--
-- 050 sends the 6-digit reset code by SMS only. This lets the same table carry
-- codes sent to the account's registered EMAIL too, so the doctor portal's
-- "Forgot password" works with email OR mobile through ONE code-based flow.
--
--   password_reset_otps
--     phone  NOT NULL → NULL      (an email-code row has no phone)
--     + email VARCHAR(190) NULL   (the normalised address the code was sent to)
--     + KEY idx_pro_email_created (email, created_at)  — per-address throttling
--
-- Exactly one of phone / email is set per row (enforced by the service).
-- NON-DESTRUCTIVE: a constraint is relaxed and a nullable column + index are
-- added. No row is rewritten or removed. Idempotent: every step checks
-- information_schema first. Applied by `npm run migrate` and, on every dev
-- boot, by db/ensurePasswordResetOtps.js.
-- ============================================================================

SET @nullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND COLUMN_NAME = 'phone');
SET @ddl := IF(@nullable = 'NO',
  'ALTER TABLE password_reset_otps MODIFY COLUMN phone VARCHAR(10) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND COLUMN_NAME = 'email');
SET @ddl := IF(@has = 0,
  'ALTER TABLE password_reset_otps ADD COLUMN email VARCHAR(190) NULL AFTER phone', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND INDEX_NAME = 'idx_pro_email_created');
SET @ddl := IF(@has = 0,
  'ALTER TABLE password_reset_otps ADD KEY idx_pro_email_created (email, created_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 052_password_reset_email_otp.sql


-- ==========================================================================
-- BEGIN folded migration: 053_rx_item_medicine_details.sql
-- ==========================================================================
-- ============================================================================
-- 053 — Structured medicine details on prescription lines
--
-- A prescription line kept the medicine as one printed label ("Pan 40 40 mg")
-- and had nowhere to keep the catalogue's dosage form, so the editor reused
-- the free-text `dosage` for strength, mixing a medicine's STRENGTH up with
-- the DOSE the doctor prescribes. These columns keep them apart.
--
--   prescription_items
--     + strength           VARCHAR(100) NULL  strength of the chosen medicine
--     + dosage_form        VARCHAR(50)  NULL  tablet / capsule / syrup / … (MEDICINE_TYPES)
--     + medicine_master_id BIGINT UNSIGNED NULL  the IHS catalogue row it came from
--                                              (FK, ON DELETE SET NULL)
--   medicines (the doctor's own list)
--     + dosage_form        VARCHAR(50)  NULL  same vocabulary as the catalogue
--
-- `medicine_name` stays the printed label, so every existing reader (PDF,
-- patient views, pharmacy sharing) keeps working unchanged.
--
-- ADDITIVE ONLY: nullable columns + an index/FK; no row is rewritten.
-- Idempotent (each step checks information_schema). Applied by
-- `npm run migrate` and, on every dev boot, by db/ensureRxItemDetails.js.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'strength');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN strength VARCHAR(100) NULL AFTER medicine_name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'dosage_form');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN dosage_form VARCHAR(50) NULL AFTER strength', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND COLUMN_NAME = 'medicine_master_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER medicine_name', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND CONSTRAINT_NAME = 'fk_rxitem_medicine_master');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescription_items ADD CONSTRAINT fk_rxitem_medicine_master FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_masters' AND COLUMN_NAME = 'dosage_form');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicine_masters ADD COLUMN dosage_form VARCHAR(50) NULL AFTER medicine_type', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 053_rx_item_medicine_details.sql


-- ==========================================================================
-- BEGIN folded migration: 054_doctor_medicine_defaults.sql
-- ==========================================================================
-- ============================================================================
-- 054 — Default prescribing instructions on the doctor's own medicine list
--
-- "My Medicines" kept only name / dosage form / strength, so every
-- prescription line needed its frequency and food direction re-entered. These
-- columns hold the doctor's DEFAULTS, copied onto a prescription line when the
-- medicine is picked (and freely changed there — a prescription line keeps its
-- own frequency / timing, so editing it never touches this row).
--
--   medicines
--     + default_frequency VARCHAR(100) NULL   e.g. "BD" (same values as prescription_items.frequency)
--     + default_timing    VARCHAR(20)  NULL   before_food | after_food | with_food | anytime
--
-- Treatment duration is deliberately NOT stored here: it is decided per patient.
--
-- ADDITIVE ONLY: two nullable columns; existing rows keep NULL and work as
-- before. Idempotent. Applied by `npm run migrate` and, on every dev boot, by
-- db/ensureDoctorMedicineDefaults.js.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'default_frequency');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN default_frequency VARCHAR(100) NULL AFTER strength', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME = 'default_timing');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicines ADD COLUMN default_timing VARCHAR(20) NULL AFTER default_frequency', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 054_doctor_medicine_defaults.sql


-- ==========================================================================
-- BEGIN folded migration: 055_patient_medicine_routines.sql
-- ==========================================================================
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

-- END folded migration: 055_patient_medicine_routines.sql


-- ==========================================================================
-- BEGIN folded migration: 056_patient_acquisition_sources.sql
-- ==========================================================================
-- ============================================================================
-- 056 — Patient acquisition sources ("How did you hear about Dr. X?")
--       (docs/doctor-dashboard-2-31-10-2026)
--
-- Two levels, kept apart on purpose:
--
--   patient_acquisition_sources  ONE row per (patient, doctor): how the patient
--                                ORIGINALLY discovered this doctor. Written once,
--                                on the first booking that carries an answer,
--                                and never overwritten by later bookings
--                                (UNIQUE patient_id + doctor_id).
--   booking_acquisition_sources  ONE row per booking (PK booking_id): what the
--                                patient answered on that booking, if anything.
--
-- `source` is a value from ACQUISITION_SOURCES (config/constants.js);
-- `source_group` (google / social / referral / ihs / other / undisclosed) is
-- derived from it server-side and stored for cheap GROUP BYs. UTM parameters
-- are kept separately in `utm` and never replace the patient's own answer.
-- Nothing is inferred from device, browser or IP.
--
-- ADDITIVE ONLY: two new tables. Idempotent. Applied by `npm run migrate` and on
-- every boot by db/ensureAcquisitionSources.js.
-- ============================================================================

CREATE TABLE IF NOT EXISTS patient_acquisition_sources (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id       BIGINT UNSIGNED NOT NULL,
  doctor_id        BIGINT UNSIGNED NOT NULL,
  source_group     VARCHAR(30) NOT NULL,
  source           VARCHAR(40) NOT NULL,
  other_text       VARCHAR(120) NULL,
  referral_details VARCHAR(160) NULL,
  first_booking_id BIGINT UNSIGNED NULL,
  captured_via     VARCHAR(20) NULL,
  captured_by      BIGINT UNSIGNED NULL,
  utm              JSON NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pas_patient_doctor (patient_id, doctor_id),
  KEY idx_pas_doctor_group (doctor_id, source_group),
  CONSTRAINT fk_pas_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pas_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pas_booking FOREIGN KEY (first_booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_pas_captured_by FOREIGN KEY (captured_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS booking_acquisition_sources (
  booking_id       BIGINT UNSIGNED NOT NULL,
  patient_id       BIGINT UNSIGNED NOT NULL,
  doctor_id        BIGINT UNSIGNED NOT NULL,
  source_group     VARCHAR(30) NOT NULL,
  source           VARCHAR(40) NOT NULL,
  other_text       VARCHAR(120) NULL,
  referral_details VARCHAR(160) NULL,
  captured_via     VARCHAR(20) NULL,
  utm              JSON NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (booking_id),
  KEY idx_bas_doctor_created (doctor_id, created_at),
  CONSTRAINT fk_bas_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_bas_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bas_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 056_patient_acquisition_sources.sql


-- ==========================================================================
-- BEGIN folded migration: 057_clinical_record_consent.sql
-- ==========================================================================
-- 057: Section-wise consent for a treating doctor to see a patient's clinical
-- history written by OTHER doctors (medical history, consultations, diagnoses,
-- medications, investigations, doctor notes, vitals).
--
-- Reuses the consent pipeline of migration 045 (doctor_access_requests +
-- access_audit_logs + in-app notifications): one request row per category, so
-- the patient approves or declines each category on its own; the grant expires
-- and can be revoked. A clinical-category request has no grant items — the
-- category itself is the grant, enforced on every read by the backend.
--
-- ADDITIVE ONLY: the category ENUM gains seven values. Existing rows and the
-- five document categories are unchanged. Applied by `npm run migrate` and,
-- idempotently, by db/ensureClinicalRecordConsent.js on every boot.

ALTER TABLE doctor_access_requests
  MODIFY COLUMN category ENUM(
    'prescription','lab_report','xray','mri','other',
    'medical_history','consultations','diagnoses','medications','investigations','doctor_notes','vitals'
  ) NOT NULL;

-- END folded migration: 057_clinical_record_consent.sql


-- ==========================================================================
-- BEGIN folded migration: 058_medical_documents.sql
-- ==========================================================================
-- ============================================================================
-- 058 — Medical documents (patient website: Medical History → Medical Documents)
--
-- Reuses uploaded_records — the one table every patient document already
-- lives in — instead of adding a second document table:
--
--   * file_type gains 'identity' (Aadhaar, ABHA, other photo ID, insurance and
--     health-scheme cards). These rows are the patient's own: the model's
--     default scope hides them from every doctor, clinic, lab and admin read.
--   * document_kind  — the finer document type the patient picked (CT scan,
--     discharge summary, …). file_type stays the broad, consent-relevant class.
--   * doctor_name    — the (possibly external) doctor named on the document.
--   * description    — the patient's notes.
--   * id_last4       — ONLY the last four digits of an ID / policy number. A
--     full Aadhaar number is never stored (Aadhaar Act s.29; UIDAI masking).
--   * original_name / mime_type / file_size — what was uploaded, for display.
--   * updated_at     — last metadata edit or file replacement (audit).
--
-- Purely additive: no existing row changes, no backfill. Idempotent
-- (information_schema-guarded), like 021/022. Boot guard: ensureMedicalDocuments.
-- ============================================================================

SET @needs := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'
    AND COLUMN_NAME = 'file_type' AND COLUMN_TYPE NOT LIKE '%identity%');
SET @ddl := IF(@needs > 0,
  "ALTER TABLE uploaded_records
     MODIFY COLUMN file_type ENUM('prescription','lab_report','xray','mri','other','identity')
     NOT NULL DEFAULT 'prescription'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'document_kind');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN document_kind VARCHAR(40) NULL AFTER file_type', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'doctor_name');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN doctor_name VARCHAR(120) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'description');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN description VARCHAR(1000) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'id_last4');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN id_last4 CHAR(4) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'original_name');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN original_name VARCHAR(255) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'mime_type');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN mime_type VARCHAR(120) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'file_size');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN file_size INT UNSIGNED NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records' AND COLUMN_NAME = 'updated_at');
SET @ddl := IF(@needs, 'ALTER TABLE uploaded_records ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 058_medical_documents.sql


-- ==========================================================================
-- BEGIN folded migration: 059_icd_master_and_rx_clinical_snapshot.sql
-- ==========================================================================
-- ============================================================================
-- 059 — Admin ICD code master, coded diagnoses, prescription clinical snapshot
--
-- ADDITIVE ONLY. Nothing existing is rewritten or dropped; every new column is
-- NULLable, so existing rows and existing clients keep working unchanged.
--
--   NEW icd_codes          — the admin-managed diagnosis/ICD catalogue. Every
--                            row names its coding system AND version (ICD-10,
--                            ICD-10-CM and ICD-11 are not interchangeable), so a
--                            code is only unique within (system, version). No
--                            codes are seeded: the catalogue is entered or
--                            imported by an administrator from a verified
--                            source.
--   clinical_entries      + icd_code_id (the catalogue row a diagnosis was
--                            picked from) and a SNAPSHOT of what was picked —
--                            code_system, code_version, code_description — so
--                            the record stays historically accurate even if the
--                            catalogue row is later edited or deactivated. The
--                            existing `code` column keeps holding the code.
--   prescriptions         + clinical_snapshot (JSON) — the Patient Workbench
--                            information (patient, consultation, vitals,
--                            complaints, examinations, diagnoses, follow-up) the
--                            prescription was written from. Frozen with the
--                            prescription when it is finalized.
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureClinicalCoding.js
-- on every boot.
-- ============================================================================

-- ── ICD code master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS icd_codes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coding_system   VARCHAR(20)     NOT NULL,
  system_version  VARCHAR(30)     NOT NULL,
  code            VARCHAR(20)     NOT NULL,
  title           VARCHAR(255)    NOT NULL,
  description     VARCHAR(1000)   NULL,
  category        VARCHAR(150)    NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED NULL,
  updated_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_icd_system_code (coding_system, system_version, code),
  KEY idx_icd_title (title),
  KEY idx_icd_active (is_active, coding_system, system_version),
  CONSTRAINT fk_icd_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_icd_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Coded diagnoses (each guarded, so re-running is a no-op) ────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'icd_code_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN icd_code_id BIGINT UNSIGNED NULL AFTER code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_system');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_system VARCHAR(20) NULL AFTER icd_code_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_version');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_version VARCHAR(30) NULL AFTER code_system', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND COLUMN_NAME = 'code_description');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD COLUMN code_description VARCHAR(1000) NULL AFTER code_version', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND INDEX_NAME = 'idx_ce_icd');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD INDEX idx_ce_icd (icd_code_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinical_entries' AND CONSTRAINT_NAME = 'fk_ce_icd');
SET @ddl := IF(@has = 0,
  'ALTER TABLE clinical_entries ADD CONSTRAINT fk_ce_icd FOREIGN KEY (icd_code_id) REFERENCES icd_codes (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Prescription clinical snapshot ──────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescriptions' AND COLUMN_NAME = 'clinical_snapshot');
SET @ddl := IF(@has = 0,
  'ALTER TABLE prescriptions ADD COLUMN clinical_snapshot JSON NULL AFTER no_medication', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- END folded migration: 059_icd_master_and_rx_clinical_snapshot.sql


-- ==========================================================================
-- BEGIN folded migration: 060_icd_import_batches.sql
-- ==========================================================================
-- ============================================================================
-- 060 — ICD & Diagnosis Master: Excel import audit trail
--
-- ADDITIVE ONLY. One new table; no existing table, column or row is touched.
--
--   NEW icd_import_batches — one row per confirmed Excel import into the
--                            icd_codes master (migration 059): who imported
--                            which file (name + SHA-256), into which version,
--                            with which duplicate policy, and what happened
--                            (inserted / updated / skipped / invalid counts,
--                            plus a capped sample of the rejected rows). A
--                            failed import is recorded too, with nothing
--                            written to icd_codes (the import is one
--                            transaction).
--
-- Applied by `npm run migrate` and, idempotently, by db/ensureIcdImportBatches.js
-- on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS icd_import_batches (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_name           VARCHAR(255)    NOT NULL,
  file_sha256         CHAR(64)        NOT NULL,
  system_version      VARCHAR(30)     NOT NULL,
  duplicate_policy    VARCHAR(10)     NOT NULL DEFAULT 'skip',
  status              VARCHAR(12)     NOT NULL,
  total_rows          INT UNSIGNED    NOT NULL DEFAULT 0,
  valid_rows          INT UNSIGNED    NOT NULL DEFAULT 0,
  invalid_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  duplicate_file_rows INT UNSIGNED    NOT NULL DEFAULT 0,
  existing_rows       INT UNSIGNED    NOT NULL DEFAULT 0,
  inserted_rows       INT UNSIGNED    NOT NULL DEFAULT 0,
  updated_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_rows        INT UNSIGNED    NOT NULL DEFAULT 0,
  systems             JSON            NULL,
  error_sample        JSON            NULL,
  failure_reason      VARCHAR(255)    NULL,
  imported_by         BIGINT UNSIGNED NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iib_created (created_at),
  CONSTRAINT fk_iib_user FOREIGN KEY (imported_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- END folded migration: 060_icd_import_batches.sql
