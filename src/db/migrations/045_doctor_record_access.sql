-- 045: Doctor record-access consent + access audit log.
--
-- A doctor who does NOT already treat a patient (no confirmed/completed
-- booking — the existing rule, unchanged) may ask the patient for ONE category
-- of their uploaded records. The patient approves by choosing the exact
-- documents to share; the grant covers only those rows, expires, and can be
-- revoked. Every request, decision, revocation and file download is written to
-- the append-only access_audit_logs table.
--
-- ADDITIVE ONLY: three new tables. No existing table, column or row is changed.
-- Applied by `npm run migrate` and, idempotently, by db/ensureDoctorRecordAccess.js
-- on every boot.

CREATE TABLE IF NOT EXISTS doctor_access_requests (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id          BIGINT UNSIGNED NOT NULL,
  patient_id         BIGINT UNSIGNED NOT NULL,
  category           ENUM('prescription','lab_report','xray','mri','other') NOT NULL,
  purpose            VARCHAR(500) NOT NULL,
  status             ENUM('pending','approved','rejected','revoked','expired','cancelled') NOT NULL DEFAULT 'pending',
  request_expires_at DATETIME NOT NULL,
  decided_at         DATETIME NULL,
  decision_note      VARCHAR(500) NULL,
  grant_expires_at   DATETIME NULL,
  revoked_at         DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dar_doctor_patient (doctor_id, patient_id, status),
  KEY idx_dar_patient_status (patient_id, status),
  CONSTRAINT fk_dar_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_dar_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doctor_access_grant_items (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id  BIGINT UNSIGNED NOT NULL,
  record_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dagi_request_record (request_id, record_id),
  KEY idx_dagi_record (record_id),
  CONSTRAINT fk_dagi_request FOREIGN KEY (request_id) REFERENCES doctor_access_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_dagi_record FOREIGN KEY (record_id) REFERENCES uploaded_records (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id  BIGINT UNSIGNED NULL,
  actor_role     VARCHAR(30) NULL,
  action         VARCHAR(50) NOT NULL,
  doctor_id      BIGINT UNSIGNED NULL,
  patient_id     BIGINT UNSIGNED NULL,
  entity_type    VARCHAR(50) NULL,
  entity_id      BIGINT UNSIGNED NULL,
  details        JSON NULL,
  ip             VARCHAR(64) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_aal_patient (patient_id, created_at),
  KEY idx_aal_doctor (doctor_id, created_at),
  KEY idx_aal_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
