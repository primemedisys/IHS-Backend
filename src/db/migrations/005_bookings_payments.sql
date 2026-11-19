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
