/**
 * Dev-only parity shim for migration 023 (doctor_patient_statuses).
 *
 * The table IS defined as a model, so `sequelize.sync()` creates it on a fresh
 * database — but an existing dev database that predates the model only gets it
 * on the next sync, and the FK/charset details must match the migration
 * exactly either way. Idempotent — a no-op once the table exists.
 */
const { QueryTypes } = require("sequelize");

async function ensureDoctorPatientStatus(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'doctor_patient_statuses'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) > 0) return false;
  await sequelize.query(
    `CREATE TABLE doctor_patient_statuses (
       doctor_id  BIGINT UNSIGNED NOT NULL,
       patient_id BIGINT UNSIGNED NOT NULL,
       status ENUM('new_patient','opd_followup','surgery_pending','surgery_followup') NOT NULL,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (doctor_id, patient_id),
       CONSTRAINT fk_dps_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
       CONSTRAINT fk_dps_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  return true;
}

module.exports = ensureDoctorPatientStatus;
