/**
 * Test environment loader — MUST be required before anything from src/.
 *
 * config/env.js calls dotenv.config(), which never overrides a variable that
 * is already set. So we load backend/.env.test FIRST: its DB_* values win, and
 * backend/.env (which points at the shared RDS database) can only fill in
 * unrelated keys such as JWT_ACCESS_SECRET.
 *
 * Then a hard guard: the tests refuse to run unless the database is on this
 * machine AND its name ends in `_test`. A mis-copied .env.test can therefore
 * never touch the RDS / production database.
 */
const path = require("path");
const fs = require("fs");

const ENV_TEST = path.join(__dirname, "..", ".env.test");
if (!fs.existsSync(ENV_TEST)) {
  console.error(
    "\n❌ backend/.env.test is missing. Copy backend/.env.test.example to backend/.env.test and fill in your LOCAL MySQL user.\n"
  );
  process.exit(1);
}
require("dotenv").config({ path: ENV_TEST });

// Values the tests control regardless of what either env file says.
Object.assign(process.env, {
  NODE_ENV: "test",
  STORAGE_DRIVER: "local",
  UPLOAD_DIR: path.join(__dirname, ".uploads"),
  RATE_LIMIT_MAX: "100000",
  AUTH_RATE_LIMIT_MAX: "100000",
  ADMIN_EMAIL: process.env.TEST_ADMIN_EMAIL || "admin@ihs-test.local",
  ADMIN_PASSWORD: process.env.TEST_ADMIN_PASSWORD || "TestAdmin#2026",
  SMTP_HOST: "",
});

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const host = String(process.env.DB_HOST || "");
const name = String(process.env.DB_NAME || "");
if (!LOCAL_HOSTS.includes(host) || !name.endsWith("_test")) {
  console.error(
    `\n❌ Refusing to run tests against DB_HOST=${host} DB_NAME=${name}.\n` +
      "   Tests only run against a LOCAL database whose name ends in _test (see backend/.env.test.example).\n"
  );
  process.exit(1);
}

module.exports = { dbName: name };
