/**
 * Dev-only parity shim for migration 029 (docs/follow-up-reminders-07-09-2026).
 *
 * Ensures the `follow_up_reminders` table and the `whatsapp_opt_in` column on
 * `patient_profiles` exist in dev databases that booted before the migration ran.
 * Idempotent — a no-op once the table and column exist.
 */
const { QueryTypes } = require("sequelize");

async function ensureFollowUpReminders(sequelize) {
  // ── 1. follow_up_reminders table ────────────────────────────────────────
  const [table] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'follow_up_reminders'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(table.t) === 0) {
    await sequelize.query(`
      CREATE TABLE follow_up_reminders (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        booking_id      BIGINT UNSIGNED NOT NULL,
        doctor_id       BIGINT UNSIGNED NOT NULL,
        patient_id      BIGINT UNSIGNED NOT NULL,
        clinic_id       BIGINT UNSIGNED NULL,
        follow_up_on    DATE         NOT NULL,
        reminder_at     DATETIME     NOT NULL,
        channel         ENUM('email','whatsapp','both') NOT NULL DEFAULT 'both',
        status          ENUM('pending','processing','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
        email_status    ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
        whatsapp_status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // ── 2. whatsapp_opt_in column ───────────────────────────────────────────
  const [col] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE() AND table_name = 'patient_profiles'
         AND column_name = 'whatsapp_opt_in'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(col.c) === 0) {
    await sequelize.query(
      `ALTER TABLE patient_profiles
         ADD COLUMN whatsapp_opt_in TINYINT(1) NOT NULL DEFAULT 0
         AFTER no_current_medications`
    );
  }
}

module.exports = ensureFollowUpReminders;
