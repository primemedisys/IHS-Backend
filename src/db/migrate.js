/**
 * Forward-only MySQL migration runner.
 *
 * Migration order:
 *   1. 000_base_schema.sql  — complete foundational schema
 *   2. every remaining *.sql file in src/db/migrations, sorted by filename
 *
 * Applied migrations are recorded in _migrations. Re-running the command
 * skips completed migrations. The base schema is a normal migration file;
 * no external docs/ path is required.
 *
 * IMPORTANT:
 * - Provision DB_NAME before running this script.
 * - The configured DB_USER needs privileges on DB_NAME to create/alter tables.
 * - MySQL DDL is not fully transactional. The base SQL uses IF NOT EXISTS and
 *   idempotent seed inserts so a partially completed base migration can retry.
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const env = require("../config/env");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const BASE_MIGRATION = "000_base_schema.sql";
const BASELINE_COVERS_THROUGH = 60;

function collectMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  if (!files.includes(BASE_MIGRATION)) {
    throw new Error(
      `Required base schema is missing: ${path.join(MIGRATIONS_DIR, BASE_MIGRATION)}`
    );
  }

  if (files[0] !== BASE_MIGRATION) {
    throw new Error(
      `${BASE_MIGRATION} must sort before all other SQL migrations. ` +
      `Found first migration: ${files[0] || "(none)"}`
    );
  }

  return files.map((file) => ({
    id: file,
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
  }));
}

async function run() {
  if (!env.DB_HOST || !env.DB_NAME || !env.DB_USER) {
    throw new Error("DB_HOST, DB_NAME and DB_USER must be configured.");
  }

  // Connect directly to the already-provisioned application database.
  // This avoids requiring the application user to have global CREATE DATABASE
  // privileges (the Docker MYSQL_DATABASE setting creates it for us).
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id VARCHAR(255) PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const [rows] = await conn.query("SELECT id FROM _migrations");
    const applied = new Set(rows.map((row) => row.id));

    let ran = 0;

  // The baseline already contains all schema changes through migration 060.
  let baselineApplied = applied.has(BASE_MIGRATION);

  for (const migration of collectMigrations()) {
    // Skip the baseline if it has already been executed.
    if (applied.has(migration.id)) {
      console.log(`↩︎  skip   ${migration.id} (already applied)`);
      continue;
    }

    // Skip historical migrations already included in the baseline.
    const match = migration.id.match(/^(\d{3})_/);
    const migrationNumber = match ? Number(match[1]) : null;

    if (
      baselineApplied &&
      migrationNumber !== null &&
      migrationNumber <= BASELINE_COVERS_THROUGH
    ) {
      console.log(
        `↩︎  skip   ${migration.id} (covered by ${BASE_MIGRATION})`
      );
      continue;
    }

    console.log(`▶︎  apply  ${migration.id}`);

    await conn.query(migration.sql);

    // Verify that the baseline created the users table.
    if (migration.id === BASE_MIGRATION) {
      const [[result]] = await conn.query(`
        SELECT COUNT(*) AS table_count
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'users'
      `);

      if (Number(result.table_count) !== 1) {
        throw new Error(
          `${BASE_MIGRATION} completed without creating the users table.`
        );
      }

      baselineApplied = true;
    }

    await conn.query(
      "INSERT INTO _migrations (id) VALUES (?)",
      [migration.id]
    );

    applied.add(migration.id);
    ran += 1;
  }

    console.log(
      ran
        ? `✅ Applied ${ran} migration(s)`
        : "✅ Up to date — nothing to apply"
    );
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exitCode = 1;
});
