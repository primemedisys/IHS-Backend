-- ============================================================================
-- 025 — Doctor-defined follow-up statuses (docs/follow-up-status)
--
-- Replaces the fixed ENUM in 023. A doctor owns their own list of categories:
-- they add, rename, recolour, reorder and delete them, because a surgeon's list
-- is not a dermatologist's. No code may ever branch on a label's TEXT — the
-- four seeded below are a starting list, not a fixed set, and any of them may
-- be renamed to anything or deleted outright.
--
-- Two tables:
--   follow_up_statuses  — the doctor's option list (label + colour + order)
--   patient_follow_ups  — doctor × patient → one CURRENT status + the date the
--                         patient is expected back
--
-- 023's doctor_patient_statuses is LEFT IN PLACE and unread for one release.
-- Dropping a table in the same migration that replaces it leaves no way back if
-- the backfill is wrong (verification query: docs/follow-up-status §4).
--
-- Idempotent (information_schema-guarded) like 013-024.
-- ============================================================================

-- ── 1. The doctor's own option list ─────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'follow_up_statuses');
SET @ddl := IF(@has = 0,
  'CREATE TABLE follow_up_statuses (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     doctor_id  BIGINT UNSIGNED NOT NULL,
     label      VARCHAR(40)  NOT NULL,
     color_hex  CHAR(7)      NOT NULL DEFAULT ''#2E86C1'',
     sort_order SMALLINT     NOT NULL DEFAULT 0,
     is_active  TINYINT(1)   NOT NULL DEFAULT 1,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_fus_doctor_label (doctor_id, label),
     KEY idx_fus_doctor (doctor_id, sort_order),
     CONSTRAINT fk_fus_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. The assignment ───────────────────────────────────────────────────────
-- PK (doctor_id, patient_id): ONE current status per pair, so setting it twice
-- is an upsert rather than a second row. fk_pfu_status deliberately has NO
-- CASCADE — it is what makes "a status in use cannot be deleted" a database
-- guarantee instead of a service-layer promise.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_follow_ups');
SET @ddl := IF(@has = 0,
  'CREATE TABLE patient_follow_ups (
     doctor_id    BIGINT UNSIGNED NOT NULL,
     patient_id   BIGINT UNSIGNED NOT NULL,
     status_id    BIGINT UNSIGNED NOT NULL,
     follow_up_on DATE         NULL,
     note         VARCHAR(140) NULL,
     booking_id   BIGINT UNSIGNED NULL,
     updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (doctor_id, patient_id),
     KEY idx_pfu_status (status_id),
     KEY idx_pfu_due (doctor_id, follow_up_on),
     CONSTRAINT fk_pfu_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pfu_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_pfu_status  FOREIGN KEY (status_id)  REFERENCES follow_up_statuses (id),
     CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. Seed every existing doctor's starting list ───────────────────────────
-- INSERT IGNORE against the (doctor_id, label) unique key, so re-running skips
-- a doctor who already has the label — including one who renamed it and made
-- their own "OPD FU" later.
INSERT IGNORE INTO follow_up_statuses (doctor_id, label, color_hex, sort_order)
SELECT u.id, seed.label, seed.color_hex, seed.sort_order
FROM users u
CROSS JOIN (
            SELECT 'NEW PATIENT' AS label, '#2E7D53' AS color_hex, 0 AS sort_order
  UNION ALL SELECT 'OPD FU',               '#2E86C1',              1
  UNION ALL SELECT 'SX WAITING',           '#B07714',              2
  UNION ALL SELECT 'SX FU',                '#5B4CB0',              3
) AS seed
WHERE u.role = 'doctor';

-- ── 4. Backfill from 023's ENUM ─────────────────────────────────────────────
INSERT IGNORE INTO patient_follow_ups (doctor_id, patient_id, status_id, follow_up_on)
SELECT dps.doctor_id, dps.patient_id, fus.id, NULL
FROM doctor_patient_statuses dps
JOIN follow_up_statuses fus
  ON fus.doctor_id = dps.doctor_id
 AND fus.label = CASE dps.status
                   WHEN 'new_patient'       THEN 'NEW PATIENT'
                   WHEN 'opd_followup'      THEN 'OPD FU'
                   WHEN 'surgery_pending'   THEN 'SX WAITING'
                   WHEN 'surgery_followup'  THEN 'SX FU'
                 END;
