/**
 * Idempotent schema guard for migration 050 (password reset by mobile OTP).
 * Safe on every boot.
 *
 * The CREATE TABLE comes straight out of migrations/050_password_reset_otps.sql
 * (one source of truth). If an earlier dev boot already let sync() create the
 * table from the model, the phone lookup index the migration declares is added
 * here, and migration 052's email channel is applied (see ensureEmailChannel).
 * No row is touched.
 */
const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "migrations", "050_password_reset_otps.sql");
const INDEX = "idx_pro_phone_created";
const EMAIL_INDEX = "idx_pro_email_created";

function createStatements() {
  const sql = fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s));
}

async function count(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return Number(rows[0].n);
}

module.exports = async function ensurePasswordResetOtps(sequelize) {
  for (const ddl of createStatements()) await sequelize.query(ddl);
  const db = sequelize.getDatabaseName();
  const hasIndex = await count(
    sequelize,
    "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'password_reset_otps' AND INDEX_NAME = :index",
    { db, index: INDEX }
  );
  if (!hasIndex) {
    await sequelize.query(`ALTER TABLE password_reset_otps ADD KEY ${INDEX} (phone, created_at)`);
  }
  await ensureEmailChannel(sequelize, db);
};

/**
 * Migration 052 (reset codes by email): `phone` becomes nullable, plus an
 * `email` column and its throttling index. Each step only when missing; no
 * row is touched.
 */
async function ensureEmailChannel(sequelize, db) {
  const [cols] = await sequelize.query(
    "SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'password_reset_otps' AND COLUMN_NAME IN ('phone', 'email')",
    { replacements: { db } }
  );
  const phone = cols.find((r) => r.c === "phone");
  if (phone && phone.n === "NO") {
    await sequelize.query("ALTER TABLE password_reset_otps MODIFY COLUMN phone VARCHAR(10) NULL");
  }
  if (!cols.some((r) => r.c === "email")) {
    await sequelize.query("ALTER TABLE password_reset_otps ADD COLUMN email VARCHAR(190) NULL AFTER phone");
  }
  const hasEmailIndex = await count(
    sequelize,
    "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'password_reset_otps' AND INDEX_NAME = :index",
    { db, index: EMAIL_INDEX }
  );
  if (!hasEmailIndex) {
    await sequelize.query(`ALTER TABLE password_reset_otps ADD KEY ${EMAIL_INDEX} (email, created_at)`);
  }
}

/** `users` must exist first (a brand-new dev DB builds it via sync()/migrate). */
module.exports.canRun = async function canRun(sequelize) {
  return (
    (await count(
      sequelize,
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'users'",
      { db: sequelize.getDatabaseName() }
    )) > 0
  );
};
