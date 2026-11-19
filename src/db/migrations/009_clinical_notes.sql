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
