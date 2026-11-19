/**
 * Idempotent schema guard for migration 038 (Diagnostic Lab Center). Safe on
 * every boot, in every environment, like ensurePharmacyOrdering.
 *
 * Every step is ADDITIVE and guarded by information_schema:
 *
 *   1. widen users.role with 'diagnostic_lab' and uploaded_records.source with
 *      'diagnostic_lab' — existing values are kept, so no row changes;
 *   2. create diagnostic_tests, diagnostic_requests, diagnostic_request_tests.
 *
 * Must run AFTER ensureClinicRole / ensureRecordAdminSource / ensurePharmacyOrdering:
 * each of those rewrites its enum with the values it knows about, so this
 * guard (which knows every value) goes last.
 */

async function count(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return Number(rows[0].n);
}

function hasTable(sequelize, db, table) {
  return count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table`,
    { db, table }
  );
}

function enumHasValue(sequelize, db, table, column, value) {
  return count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column
         AND COLUMN_TYPE LIKE :needle`,
    { db, table, column, needle: `%'${value}'%` }
  );
}

/** Widen one enum column, but only when the table exists and the value is missing. */
async function widenEnum(sequelize, db, { table, column, value, ddl, label }) {
  if (!(await hasTable(sequelize, db, table))) return;
  if (await enumHasValue(sequelize, db, table, column, value)) return;
  await sequelize.query(ddl);
  console.log(`✅ ${label} (migration 038)`);
}

/** Create a table only when it is missing (sync() may already have made it in dev). */
async function createTable(sequelize, db, table, ddl) {
  if (await hasTable(sequelize, db, table)) return;
  await sequelize.query(ddl);
  console.log(`✅ Created ${table} (migration 038)`);
}

module.exports = async function ensureDiagnosticLab(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) Enums. Without these a lab signup / a filed lab report fails with a
  //    data-truncation error (the failure mode ensureClinicRole documents).
  await widenEnum(sequelize, db, {
    table: "users",
    column: "role",
    value: "diagnostic_lab",
    label: "Added 'diagnostic_lab' to users.role",
    ddl: `ALTER TABLE users MODIFY COLUMN role
            ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab')
            NOT NULL DEFAULT 'patient'`,
  });
  await widenEnum(sequelize, db, {
    table: "uploaded_records",
    column: "source",
    value: "diagnostic_lab",
    label: "Added 'diagnostic_lab' to uploaded_records.source",
    ddl: `ALTER TABLE uploaded_records MODIFY COLUMN source
            ENUM('patient','doctor','clinic','admin','diagnostic_lab') NOT NULL DEFAULT 'patient'`,
  });

  // 2) Tables (mirrors src/db/migrations/038_diagnostic_lab.sql).
  await createTable(sequelize, db, "diagnostic_tests", `
    CREATE TABLE diagnostic_tests (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      lab_id        BIGINT UNSIGNED NOT NULL,
      name          VARCHAR(150)    NOT NULL,
      description   VARCHAR(500)    NULL,
      price         DECIMAL(10,2)   NOT NULL,
      is_available  TINYINT(1)      NOT NULL DEFAULT 1,
      is_active     TINYINT(1)      NOT NULL DEFAULT 1,
      created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_dt_lab (lab_id, is_active),
      CONSTRAINT fk_dt_lab FOREIGN KEY (lab_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await createTable(sequelize, db, "diagnostic_requests", `
    CREATE TABLE diagnostic_requests (
      id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      patient_id            BIGINT UNSIGNED NOT NULL,
      lab_id                BIGINT UNSIGNED NOT NULL,
      file_url              VARCHAR(512)    NOT NULL,
      file_name             VARCHAR(255)    NULL,
      notes                 TEXT            NULL,
      status                ENUM('pending','viewed','available','booking_requested','confirmed','test_completed','report_ready','rejected') NOT NULL DEFAULT 'pending',
      lab_note              VARCHAR(500)    NULL,
      preferred_date        DATE            NULL,
      booking_notes         VARCHAR(500)    NULL,
      responded_at          DATETIME        NULL,
      booking_requested_at  DATETIME        NULL,
      confirmed_at          DATETIME        NULL,
      completed_at          DATETIME        NULL,
      report_ready_at       DATETIME        NULL,
      created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_dr_patient (patient_id),
      KEY idx_dr_lab     (lab_id),
      KEY idx_dr_status  (status),
      CONSTRAINT fk_dr_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_dr_lab     FOREIGN KEY (lab_id)     REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await createTable(sequelize, db, "diagnostic_request_tests", `
    CREATE TABLE diagnostic_request_tests (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      diagnostic_request_id  BIGINT UNSIGNED NOT NULL,
      diagnostic_test_id     BIGINT UNSIGNED NULL,
      test_name              VARCHAR(150)    NOT NULL,
      price                  DECIMAL(10,2)   NULL,
      status                 ENUM('available','unavailable') NOT NULL,
      reason                 VARCHAR(255)    NULL,
      is_selected            TINYINT(1)      NOT NULL DEFAULT 0,
      report_record_id       BIGINT UNSIGNED NULL,
      report_uploaded_at     DATETIME        NULL,
      created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_drt_request (diagnostic_request_id),
      KEY idx_drt_test    (diagnostic_test_id),
      KEY idx_drt_report  (report_record_id),
      CONSTRAINT fk_drt_request FOREIGN KEY (diagnostic_request_id) REFERENCES diagnostic_requests (id) ON DELETE CASCADE,
      CONSTRAINT fk_drt_test    FOREIGN KEY (diagnostic_test_id)    REFERENCES diagnostic_tests (id)    ON DELETE SET NULL,
      CONSTRAINT fk_drt_report  FOREIGN KEY (report_record_id)      REFERENCES uploaded_records (id)    ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
};
