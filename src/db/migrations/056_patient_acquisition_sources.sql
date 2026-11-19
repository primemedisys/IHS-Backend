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
