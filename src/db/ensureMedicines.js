/**
 * Dev-only parity shim for the medicines table.
 *
 * The table IS defined as a model, so `sequelize.sync()` creates it on a fresh
 * database — but an existing dev database that predates the model only gets it
 * on the next sync. Idempotent — a no-op once the table exists.
 */
const { QueryTypes } = require("sequelize");

async function ensureMedicines(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'medicines'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) > 0) return false;
  await sequelize.query(
    `CREATE TABLE medicines (
       id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       doctor_id  BIGINT UNSIGNED NOT NULL,
       name       VARCHAR(200) NOT NULL,
       form       ENUM('oral','topical','injection','drops','inhaler','other') NOT NULL DEFAULT 'oral',
       strength   VARCHAR(100) DEFAULT NULL,
       category   VARCHAR(100) DEFAULT NULL,
       is_active  TINYINT(1) NOT NULL DEFAULT 1,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       INDEX idx_med_doctor (doctor_id),
       INDEX idx_med_doctor_name (doctor_id, name),
       INDEX idx_med_doctor_active (doctor_id, is_active),
       CONSTRAINT fk_med_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id) ON DELETE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  return true;
}

module.exports = ensureMedicines;
