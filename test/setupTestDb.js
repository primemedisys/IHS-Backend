/**
 * Build the LOCAL test database the same way production gets its schema:
 *
 *   1. `src/db/migrate.js` — the project's own forward-only runner (base schema
 *      from docs/dbstruct.md + every numbered migration, incl. 038 and 039),
 *   2. the ensure* guards production runs on every boot,
 *   3. the admin seed (with the test admin from testEnv).
 *
 * Usage:  npm run test:db          (idempotent; add --fresh to drop + recreate)
 */
const { dbName } = require("./testEnv");
const { spawnSync } = require("child_process");
const path = require("path");
const mysql = require("mysql2/promise");

async function main() {
  const fresh = process.argv.includes("--fresh");
  if (fresh) {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.end();
    console.log(`🗑  dropped ${dbName}`);
  }

  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "db", "migrate.js")], {
    env: process.env,
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  if (res.status !== 0) process.exit(res.status || 1);

  const { sequelize } = require("../src/models");
  // The same boot-time guards server.js runs in every environment.
  for (const name of [
    "ensureQueueColumns",
    "ensurePrescriptionAvailability",
    "ensureMedicineMaster",
    "ensurePharmacyOrdering",
    "ensureMedicineMedia",
    "ensureDiagnosticLab",
    "ensureBloodBank",
    "ensureAmbulance",
    "ensurePharmacyManagement",
    "ensurePaymentQr",
  ]) {
    // eslint-disable-next-line no-await-in-loop, global-require
    await require(`../src/db/${name}`)(sequelize);
  }
  // eslint-disable-next-line global-require
  await require("../src/seeders/admin.seeder")();
  await sequelize.close();
  console.log(`✅ Test database ${dbName} is ready`);
}

main().catch((err) => {
  console.error("❌ Test DB setup failed:", err);
  process.exit(1);
});
