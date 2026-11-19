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
