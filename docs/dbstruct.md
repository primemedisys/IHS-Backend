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
CREATE TABLE users (
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
) ENGINE=InnoDB;

-- ============================================================================
-- 2. PATIENT PROFILES  (1:1 -> users, where role='patient')
-- ============================================================================
CREATE TABLE patient_profiles (
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
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2a. ALLERGIES lookup + patient<->allergy junction  ==>  (M:N)
--     Was previously a free-text/JSON column. Normalized so allergies are
--     queryable ("find all patients allergic to penicillin") and consistent.
-- ----------------------------------------------------------------------------
CREATE TABLE allergies (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_allergy_name (name)
) ENGINE=InnoDB;

CREATE TABLE patient_allergies (                          -- (M:N) junction
    patient_id  BIGINT UNSIGNED NOT NULL,
    allergy_id  INT UNSIGNED NOT NULL,
    severity    ENUM('mild','moderate','severe') NULL,
    PRIMARY KEY (patient_id, allergy_id),
    CONSTRAINT fk_patalg_patient FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patalg_allergy FOREIGN KEY (allergy_id) REFERENCES allergies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2b. CONDITIONS lookup + patient<->condition junction  ==>  (M:N)
--     Same normalization for chronic conditions (diabetes, hypertension...).
-- ----------------------------------------------------------------------------
CREATE TABLE conditions (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_condition_name (name)
) ENGINE=InnoDB;

CREATE TABLE patient_conditions (                          -- (M:N) junction
    patient_id    BIGINT UNSIGNED NOT NULL,
    condition_id  INT UNSIGNED NOT NULL,
    diagnosed_year SMALLINT UNSIGNED NULL,
    PRIMARY KEY (patient_id, condition_id),
    CONSTRAINT fk_patcond_patient   FOREIGN KEY (patient_id) REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_patcond_condition FOREIGN KEY (condition_id) REFERENCES conditions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2c. PATIENT CURRENT MEDICATIONS  ==>  (1:M) patient -> many med rows
--     Not a lookup+junction (M:N) because dosage/notes are specific to that
--     patient's entry, not a reusable attribute like an allergy name.
-- ----------------------------------------------------------------------------
CREATE TABLE patient_current_medications (
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

-- ============================================================================
-- 3. FAMILY MEMBERS  ==>  (1:M) patient -> many dependents
-- ============================================================================
CREATE TABLE family_members (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id   BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(150) NOT NULL,
    relation     VARCHAR(50)  NULL,
    age          SMALLINT UNSIGNED NULL,
    gender       ENUM('male','female','other') NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_family_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 4. SPECIALIZATIONS lookup (Cardiologist, Dermatologist, etc.)
-- ============================================================================
CREATE TABLE specializations (
    id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name   VARCHAR(120) NOT NULL,
    slug   VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_spec_slug (slug)
) ENGINE=InnoDB;

-- ============================================================================
-- 5. LANGUAGES lookup + doctor<->language junction  ==>  (M:N)
--    Was previously a comma-separated column on doctor_profiles.
-- ============================================================================
CREATE TABLE languages (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(60) NOT NULL,
    UNIQUE KEY uq_language_name (name)
) ENGINE=InnoDB;

-- ============================================================================
-- 6. DOCTOR PROFILES  ==>  (1:1) users -> doctor_profiles
--    NOTE: bank/payout details are intentionally NOT here — see
--    doctor_bank_details below. Keeping financial data in its own table
--    means it can carry its own access controls, audit trail, and can hold
--    a history of accounts (a doctor may change bank accounts over time)
--    without mutating the doctor's public profile row.
-- ============================================================================
CREATE TABLE doctor_profiles (
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
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6a. DOCTOR BANK / PAYOUT DETAILS  ==>  (1:1) doctor -> current payout account
--     Split out from doctor_profiles. A doctor has exactly one ACTIVE payout
--     account at a time (enforced by is_active + application logic), but this
--     table can hold history (old rows kept with is_active=0) — something
--     impossible to represent if it were columns on doctor_profiles.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_bank_details (
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
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6b. DOCTOR AWARDS / ACHIEVEMENTS  ==>  (1:M) doctor -> many award rows
--     Normalized out of the old free-text/JSON column for a proper portfolio.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_awards (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    title        VARCHAR(255) NOT NULL,
    description  VARCHAR(500) NULL,
    award_year   SMALLINT UNSIGNED NULL,

    CONSTRAINT fk_award_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_award_doctor (doctor_id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6c. DOCTOR SOCIAL / WEB LINKS  ==>  (1:M) doctor -> many link rows
--     Normalized instead of fixed linkedin_url/website_url columns, so a
--     doctor can add Instagram, YouTube, a personal site, etc. without a
--     schema change every time a new platform matters.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_links (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    link_type    ENUM('website','linkedin','instagram','youtube','other') NOT NULL,
    url          VARCHAR(300) NOT NULL,

    CONSTRAINT fk_link_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_link_doctor (doctor_id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6d. DOCTOR <-> SPECIALIZATION  ==>  (M:N)  a doctor can have 1+ specialties,
--     a specialty has many doctors.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_specializations (
    doctor_id          BIGINT UNSIGNED NOT NULL,
    specialization_id  INT UNSIGNED NOT NULL,

    PRIMARY KEY (doctor_id, specialization_id),
    CONSTRAINT fk_docspec_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docspec_spec   FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6e. DOCTOR <-> LANGUAGE  ==>  (M:N)  a doctor speaks many languages,
--     a language is spoken by many doctors.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_languages (
    doctor_id    BIGINT UNSIGNED NOT NULL,
    language_id  INT UNSIGNED NOT NULL,

    PRIMARY KEY (doctor_id, language_id),
    CONSTRAINT fk_doclang_doctor   FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_doclang_language FOREIGN KEY (language_id) REFERENCES languages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 6f–6m. PORTFOLIO CONTENT TABLES  (added by migration 004_doctor_portfolio_v2)
--   These flesh out the public portfolio's remaining sections. Each row belongs
--   to one doctor (1:M). `display_order` lets the doctor order cards in the UI.
--   REQUIRED-to-submit sections are marked; the rest are optional-but-encouraged
--   (the submit gate reads ONBOARDING_REQUIRED_STEPS in config/constants.js).
-- ============================================================================

-- 6f. DOCTOR EDUCATION  ==>  (1:M)  structured qualifications & schooling  [REQUIRED >=1]
CREATE TABLE doctor_education (
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
) ENGINE=InnoDB;

-- 6g. DOCTOR EXPERIENCE  ==>  (1:M)  career timeline (hospitals / positions)  [REQUIRED >=1]
CREATE TABLE doctor_experience (
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
) ENGINE=InnoDB;

-- 6h. DOCTOR SERVICES  ==>  (1:M)  procedures / treatments offered  [REQUIRED >=1]
CREATE TABLE doctor_services (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(150) NOT NULL,               -- e.g. "Angioplasty"
    description   VARCHAR(500) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_service_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_service_doctor (doctor_id)
) ENGINE=InnoDB;

-- 6i. DOCTOR PUBLICATIONS & RESEARCH  ==>  (1:M)  papers / journals  (optional)
CREATE TABLE doctor_publications (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    title         VARCHAR(300) NOT NULL,
    publisher     VARCHAR(200) NULL,                   -- journal / conference name
    year          SMALLINT UNSIGNED NULL,
    url           VARCHAR(300) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_publication_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_publication_doctor (doctor_id)
) ENGINE=InnoDB;

-- 6j. DOCTOR MEMBERSHIPS  ==>  (1:M)  medical bodies / associations  (optional)
CREATE TABLE doctor_memberships (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    organization  VARCHAR(200) NOT NULL,               -- e.g. "Medical Council of India"
    role_title    VARCHAR(150) NULL,                   -- e.g. "Fellow", "Life Member"
    since_year    SMALLINT UNSIGNED NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_membership_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_membership_doctor (doctor_id)
) ENGINE=InnoDB;

-- 6k. DOCTOR GALLERY  ==>  (1:M)  clinic / practice photos  (optional)
CREATE TABLE doctor_gallery (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    image_url     VARCHAR(500) NOT NULL,
    caption       VARCHAR(255) NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_gallery_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_gallery_doctor (doctor_id)
) ENGINE=InnoDB;

-- 6l. DOCTOR FAQ  ==>  (1:M)  common patient questions  (optional)
CREATE TABLE doctor_faqs (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id     BIGINT UNSIGNED NOT NULL,
    question      VARCHAR(300) NOT NULL,
    answer        VARCHAR(1000) NOT NULL,
    display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,

    CONSTRAINT fk_faq_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_faq_doctor (doctor_id)
) ENGINE=InnoDB;

-- 6m. INSURANCE lookup + doctor<->insurance junction  ==>  (M:N)  (optional)
--     Normalized so "find doctors accepting <provider>" is queryable, mirroring
--     the specializations/languages pattern.
CREATE TABLE insurances (
    id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(150) NOT NULL,
    UNIQUE KEY uq_insurance_name (name)
) ENGINE=InnoDB;

CREATE TABLE doctor_insurances (                          -- (M:N) junction
    doctor_id     BIGINT UNSIGNED NOT NULL,
    insurance_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (doctor_id, insurance_id),
    CONSTRAINT fk_docins_doctor    FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_docins_insurance FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 7. DOCTOR DOCUMENTS  ==>  (1:M) doctor -> many uploaded documents
-- ============================================================================
CREATE TABLE doctor_documents (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    doc_type     ENUM('degree_certificate','id_proof','council_registration','other') NOT NULL,
    file_url     VARCHAR(500) NOT NULL,
    uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_docdoc_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    KEY idx_docdoc_doctor (doctor_id)
) ENGINE=InnoDB;

-- ============================================================================
-- 8. CLINICS  ==>  (1:M) doctor -> many clinics
-- ============================================================================
CREATE TABLE clinics (
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

-- ============================================================================
-- 9. CLINIC AVAILABILITY  ==>  (1:M) clinic -> many recurring weekly slots
-- ============================================================================
CREATE TABLE clinic_availability (
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

-- ============================================================================
-- 10. DOCTOR ONLINE AVAILABILITY  ==>  (1:M) doctor -> many video-consult slots
--     Independent of any clinic.
-- ============================================================================
CREATE TABLE doctor_online_availability (
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

-- ============================================================================
-- 11. AVAILABILITY EXCEPTIONS  ==>  (1:M) doctor -> many blocked dates,
--     optionally scoped to one (M:1) clinic; NULL clinic_id = online.
-- ============================================================================
CREATE TABLE availability_exceptions (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id      BIGINT UNSIGNED NOT NULL,
    clinic_id      BIGINT UNSIGNED NULL,
    exception_date DATE NOT NULL,
    reason         VARCHAR(255) NULL,

    CONSTRAINT fk_exception_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_exception_clinic FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE,
    KEY idx_exception_doctor_date (doctor_id, exception_date)
) ENGINE=InnoDB;

-- ============================================================================
-- 12. BOOKINGS  ==>  (M:1) to patient, (M:1) to doctor, (M:1) to clinic
--     (nullable), (M:1) to family_member (nullable)
-- ============================================================================
CREATE TABLE bookings (
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
) ENGINE=InnoDB;

-- ============================================================================
-- 13. PAYMENTS  ==>  (1:1) booking -> payment
-- ============================================================================
CREATE TABLE payments (
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
CREATE TABLE prescriptions (
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
) ENGINE=InnoDB;

-- ============================================================================
-- 15. PRESCRIPTION ITEMS  ==>  (1:M) prescription -> many medicine rows
-- !! SUPERSEDED by migration 006_prescriptions.sql — see the note on §14.
-- ============================================================================
CREATE TABLE prescription_items (
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
) ENGINE=InnoDB;

-- ============================================================================
-- 16. UPLOADED RECORDS  ==>  (1:M) patient -> many uploaded past records
-- ============================================================================
CREATE TABLE uploaded_records (
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

-- ============================================================================
-- 17. REVIEWS  ==>  (1:1) booking -> review, (M:1) to patient, (M:1) to doctor
-- ============================================================================
CREATE TABLE reviews (
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
) ENGINE=InnoDB;

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
CREATE TABLE symptom_specialization_map (
    id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    symptom_keyword    VARCHAR(150) NOT NULL,
    specialization_id  INT UNSIGNED NOT NULL,
    weight             TINYINT UNSIGNED NOT NULL DEFAULT 1,

    CONSTRAINT fk_symptom_spec FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE,
    KEY idx_symptom_keyword (symptom_keyword)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 18b. DOCTOR SEARCH KEYWORDS  ==>  (1:M) doctor -> many self-added keywords
--      This is the PER-DOCTOR ADD-ON layer. A doctor can tag themselves for
--      symptoms beyond what their specialization implies by default — e.g.
--      an Orthopedic doctor who specifically treats "leg pain" and wants to
--      show up for that exact search, even if "leg pain" isn't in the global
--      symptom_specialization_map. Doctor adds these from their dashboard;
--      admin can moderate/reject irrelevant ones via is_approved.
-- ----------------------------------------------------------------------------
CREATE TABLE doctor_search_keywords (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id    BIGINT UNSIGNED NOT NULL,
    keyword      VARCHAR(150) NOT NULL,
    weight       TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- doctor/admin can boost relevance
    is_approved  TINYINT(1) NOT NULL DEFAULT 1,          -- admin can moderate self-added tags
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_doctorkeyword_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    UNIQUE KEY uq_doctor_keyword (doctor_id, keyword),
    KEY idx_doctorkeyword_keyword (keyword)
) ENGINE=InnoDB;

-- ============================================================================
-- 19. EMAIL NOTIFICATIONS LOG  ==>  (1:M) user -> many sent emails,
--     (M:1) optionally tied to one booking
-- ============================================================================
CREATE TABLE email_notifications (
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
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- SEED DATA (minimal, for local dev/testing)
-- ============================================================================
INSERT INTO specializations (name, slug) VALUES
  ('Cardiologist', 'cardiologist'),
  ('Dermatologist', 'dermatologist'),
  ('General Physician', 'general-physician'),
  ('Pediatrician', 'pediatrician'),
  ('Orthopedic', 'orthopedic'),
  ('ENT Specialist', 'ent-specialist'),
  ('Gynecologist', 'gynecologist'),
  ('Psychiatrist', 'psychiatrist');

INSERT INTO languages (name) VALUES
  ('English'), ('Hindi'), ('Odia'), ('Bengali'), ('Telugu');

INSERT INTO insurances (name) VALUES
  ('Star Health'), ('HDFC ERGO'), ('ICICI Lombard'), ('Niva Bupa'),
  ('LIC Health'), ('CGHS'), ('Ayushman Bharat (PM-JAY)'), ('Self-pay / No insurance');

INSERT INTO allergies (name) VALUES
  ('Penicillin'), ('Dust'), ('Pollen'), ('Peanuts'), ('Latex');

INSERT INTO conditions (name) VALUES
  ('Diabetes'), ('Hypertension'), ('Asthma'), ('Hypothyroidism'), ('Arthritis');

-- global default symptom -> specialization mapping
INSERT INTO symptom_specialization_map (symptom_keyword, specialization_id, weight) VALUES
  ('chest pain', 1, 5),
  ('palpitations', 1, 4),
  ('skin rash', 2, 5),
  ('acne', 2, 3),
  ('fever', 3, 3),
  ('cold and cough', 3, 3),
  ('child fever', 4, 5),
  ('joint pain', 5, 4),
  ('back pain', 5, 4),
  ('leg pain', 5, 4),
  ('ear pain', 6, 5),
  ('sore throat', 6, 3),
  ('pregnancy', 7, 5),
  ('anxiety', 8, 5),
  ('sleep issues', 8, 3);

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
