-- ============================================================================
-- 023 — Per-doctor patient status (My Patients categorisation)
--
-- The doctor's sketch: every patient in My Patients carries one of four
-- statuses — new patient / OPD follow-up / surgery pending / surgery follow-up.
-- New/OPD are DERIVED from visit count at read time; this table stores only
-- the doctor's manual overrides, which is why every existing roster keeps
-- working with zero rows here.
--
-- Status is per doctor↔patient PAIR, never global: the same person can be a
-- surgery follow-up for their surgeon and a new patient to a dermatologist.
--
-- ON DELETE CASCADE both ways — a status row is meaningless without either
-- party and holds no clinical data worth preserving.
--
-- Idempotent (information_schema-guarded) like 013-022.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doctor_patient_statuses');
SET @ddl := IF(@has = 0,
  'CREATE TABLE doctor_patient_statuses (
     doctor_id  BIGINT UNSIGNED NOT NULL,
     patient_id BIGINT UNSIGNED NOT NULL,
     status ENUM(''new_patient'',''opd_followup'',''surgery_pending'',''surgery_followup'') NOT NULL,
     updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (doctor_id, patient_id),
     CONSTRAINT fk_dps_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_dps_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
