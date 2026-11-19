/**
 * Minimal forward-only SQL migration runner. `npm run migrate` applies, in order:
 *   1. the canonical base schema  (docs/dbstruct.md)  → tracked as "000_base_schema"
 *   2. every *.sql in this folder  (src/db/migrations) → tracked by filename
 *
 * Applied migrations are recorded in a `_migrations` table, so re-running is a
 * no-op — safe to run on every deploy. We keep the base schema as the single
 * source of truth (no duplicate copy) by reading it straight from docs/.
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const env = require("../config/env");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const BASE_SCHEMA = path.resolve(__dirname, "..", "..", "..", "docs", "dbstruct.md");

/** Pull the SQL out of docs/dbstruct.md (strip a ```sql fence if present). */
function readBaseSchema() {
  if (!fs.existsSync(BASE_SCHEMA)) return null;
  let sql = fs.readFileSync(BASE_SCHEMA, "utf8");
  const fence = sql.match(/```sql\s*([\s\S]*?)```/i);
  if (fence) sql = fence[1];
  return sql;
}

/** Ordered list of { id, sql } to apply. */
function collectMigrations() {
  const list = [];

  const base = readBaseSchema();
  if (base) list.push({ id: "000_base_schema", sql: base });

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    list.push({ id: file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8") });
  }
  return list;
}

async function run() {
  // Connect WITHOUT a database (the base schema creates it) and allow the
  // multi-statement .sql files to run as a single query each.
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.query(`USE \`${env.DB_NAME}\``);
    await conn.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         id          VARCHAR(255) PRIMARY KEY,
         applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB`
    );

    const [rows] = await conn.query("SELECT id FROM _migrations");
    const applied = new Set(rows.map((r) => r.id));

    let ran = 0;
    for (const m of collectMigrations()) {
      if (applied.has(m.id)) {
        console.log(`↩︎  skip   ${m.id} (already applied)`);
        continue;
      }
      console.log(`▶︎  apply  ${m.id}`);
      await conn.query(m.sql);
      // Re-select the working DB in case a migration issued its own USE.
      await conn.query(`USE \`${env.DB_NAME}\``);
      await conn.query("INSERT INTO _migrations (id) VALUES (?)", [m.id]);
      ran += 1;
    }

    console.log(ran ? `✅ Applied ${ran} migration(s)` : "✅ Up to date — nothing to apply");
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
