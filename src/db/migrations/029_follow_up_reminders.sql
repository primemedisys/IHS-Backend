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
