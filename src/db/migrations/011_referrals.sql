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
