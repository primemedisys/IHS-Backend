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
