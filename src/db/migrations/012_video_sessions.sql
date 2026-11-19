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
