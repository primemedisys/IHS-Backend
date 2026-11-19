/**
 * Parity shim for migration 027 (docs/consultation-queue).
 *
 * Ensures the `consultation_sessions` table and the six queue columns on
 * `bookings` exist, even if the migration was never applied. Also handles the
 * generated columns (`clinic_key`, `active_lock_key`) that `sequelize.sync()`
 * cannot express.
 *
 * Runs on every boot in ALL environments — idempotent: each step probes
 * information_schema and returns early when the schema is already in place.
 */
const { QueryTypes } = require("sequelize");

const tableExists = async (sequelize, table) => {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = :table`,
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(row.n) > 0;
};

const columnExists = async (sequelize, table, column) => {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
    { type: QueryTypes.SELECT, replacements: { table, column } }
  );
  return Number(row.n) > 0;
};

const indexExists = async (sequelize, table, index) => {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :index`,
    { type: QueryTypes.SELECT, replacements: { table, index } }
  );
  return Number(row.n) > 0;
};

/**
 * Create the `consultation_sessions` table if it doesn't exist.
 *
 * Mirrors the CREATE TABLE from migration 027 — VIRTUAL `clinic_key` and all.
 * Safe to run on an existing table (IF NOT EXISTS) or a fresh database.
 */
async function ensureConsultationSessionsTable(sequelize) {
  if (await tableExists(sequelize, "consultation_sessions")) return false;

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS consultation_sessions (
        id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        doctor_id           BIGINT UNSIGNED NOT NULL,
        clinic_id           BIGINT UNSIGNED NULL,
        session_date        DATE            NOT NULL,
        start_time          TIME            NOT NULL,
        end_time            TIME            NOT NULL,
        status              ENUM('scheduled','in_progress','paused','completed','cancelled')
                              NOT NULL DEFAULT 'scheduled',
        max_bookings        SMALLINT UNSIGNED NULL,
        next_token          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        current_booking_id  BIGINT UNSIGNED NULL,
        avg_consult_minutes SMALLINT UNSIGNED NULL,
        started_at          DATETIME NULL,
        ended_at            DATETIME NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        clinic_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(clinic_id, 0)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_session_slotless (doctor_id, session_date, clinic_key, start_time),
        KEY idx_session_doctor_date (doctor_id, session_date),
        KEY idx_session_status (status),
        CONSTRAINT fk_session_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id),
        CONSTRAINT fk_session_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  return true;
}

/**
 * Add the six queue columns to `bookings` if they don't exist.
 *
 * Mirrors step 2 of migration 027. Nullable so existing rows are untouched.
 * Includes the index and FK that migration 027 adds.
 */
async function ensureBookingQueueColumns(sequelize) {
  if (!(await tableExists(sequelize, "bookings"))) return false;
  if (await columnExists(sequelize, "bookings", "session_id")) return false;

  await sequelize.query(`
    ALTER TABLE bookings
      ADD COLUMN session_id         BIGINT UNSIGNED NULL AFTER clinic_id,
      ADD COLUMN queue_number       SMALLINT UNSIGNED NULL AFTER session_id,
      ADD COLUMN queue_state        ENUM('waiting','serving','done','skipped') NULL AFTER queue_number,
      ADD COLUMN called_at          DATETIME NULL,
      ADD COLUMN consult_started_at DATETIME NULL,
      ADD COLUMN consult_ended_at   DATETIME NULL,
      ADD KEY idx_booking_session_queue (session_id, queue_number),
      ADD CONSTRAINT fk_booking_session FOREIGN KEY (session_id) REFERENCES consultation_sessions (id)
  `);
  return true;
}

/**
 * The generated `clinic_key` + the uniqueness it exists to make possible.
 *
 * VIRTUAL, not STORED: this table has FKs to doctor_profiles and clinics, and a
 * STORED generated column forces a full table copy that re-creates them and
 * fails with errno 1215 (the same trap ensureBookingLockKey.js documents). A
 * virtual column is added in place, and MySQL 8 indexes it just as well.
 */
async function ensureSessionClinicKey(sequelize) {
  if (!(await tableExists(sequelize, "consultation_sessions"))) return false;
  if (await columnExists(sequelize, "consultation_sessions", "clinic_key")) return false;

  await sequelize.query(
    `ALTER TABLE consultation_sessions
       ADD COLUMN clinic_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(clinic_id, 0)) VIRTUAL,
       ADD UNIQUE KEY uq_session_slotless (doctor_id, session_date, clinic_key, start_time)`
  );
  return true;
}

/**
 * Re-point `bookings.active_lock_key` from the slot key to the token key.
 *
 * Guarded on the INDEX rather than the column: sync() leaves the column in place
 * with the old expression, so "does the column exist" would report success while
 * the old cap was still enforced.
 */
async function ensureBookingTokenLock(sequelize) {
  if (!(await tableExists(sequelize, "bookings"))) return false;
  if (await indexExists(sequelize, "bookings", "uq_booking_session_token")) return false;
  // The token key is meaningless until the columns it concatenates exist.
  if (!(await columnExists(sequelize, "bookings", "queue_number"))) return false;

  if (await indexExists(sequelize, "bookings", "uq_booking_doctor_slot_lock")) {
    await sequelize.query(`ALTER TABLE bookings DROP INDEX uq_booking_doctor_slot_lock`);
  }
  if (await columnExists(sequelize, "bookings", "active_lock_key")) {
    await sequelize.query(`ALTER TABLE bookings DROP COLUMN active_lock_key`);
  }
  await sequelize.query(
    `ALTER TABLE bookings
       ADD COLUMN active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
         CASE WHEN status IN ('pending_payment','confirmed') AND session_id IS NOT NULL
              THEN CONCAT(session_id, '_', queue_number)
              ELSE NULL END
       ) VIRTUAL,
       ADD UNIQUE KEY uq_booking_session_token (active_lock_key)`
  );
  return true;
}

/** `max_bookings` on both weekly templates — sync() adds it, but not on a DB
 *  created before the model carried it. */
async function ensureTemplateCaps(sequelize) {
  let changed = false;
  for (const table of ["clinic_availability", "doctor_online_availability"]) {
    if (!(await tableExists(sequelize, table))) continue;
    if (await columnExists(sequelize, table, "max_bookings")) continue;
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN max_bookings SMALLINT UNSIGNED NULL`);
    changed = true;
  }
  return changed;
}

/**
 * Repair the session table's timestamp defaults.
 *
 * Same failure `ensureFollowUpColumns` documents: sequelize.sync() creates
 * `created_at`/`updated_at` as `datetime NOT NULL` with NO default, so any
 * INSERT that does not name them (the migration's own backfill, for one) is
 * rejected outright with "Field 'created_at' doesn't have a default value".
 */
async function ensureSessionTimestamps(sequelize) {
  if (!(await tableExists(sequelize, "consultation_sessions"))) return false;
  const [row] = await sequelize.query(
    `SELECT COLUMN_DEFAULT AS def FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'consultation_sessions'
         AND column_name = 'created_at'`,
    { type: QueryTypes.SELECT }
  );
  if (row && row.def) return false; // already defaulted

  await sequelize.query(
    `ALTER TABLE consultation_sessions
       MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
  );
  return true;
}

async function ensureQueueColumns(sequelize) {
  // 1. Ensure the consultation_sessions table exists (prerequisite for everything else).
  const s = await ensureConsultationSessionsTable(sequelize);
  // 2. Ensure the six queue columns exist on bookings (FK depends on the table above).
  const q = await ensureBookingQueueColumns(sequelize);
  // 3. Repair timestamps that sync() creates without defaults.
  const t = await ensureSessionTimestamps(sequelize);
  // 4. Add the generated clinic_key + unique key.
  const a = await ensureSessionClinicKey(sequelize);
  // 5. Add max_bookings to weekly templates.
  const b = await ensureTemplateCaps(sequelize);
  // 6. Re-point active_lock_key from slot key to token key.
  const c = await ensureBookingTokenLock(sequelize);
  return s || q || t || a || b || c;
}

module.exports = ensureQueueColumns;
