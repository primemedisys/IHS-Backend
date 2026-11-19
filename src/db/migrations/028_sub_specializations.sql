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
