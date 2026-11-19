/**
 * Idempotent admin upsert. The admin's identity (email) and password live ONLY
 * in .env; the DB stores a bcrypt hash. Running this many times never creates a
 * duplicate: if the admin exists we only re-hash when the .env password changed.
 *
 * Called from server.js on boot, and runnable standalone: `npm run seed:admin`.
 */
const env = require("../config/env");
const { User } = require("../models");
const password = require("../utils/password");
const { ROLES, AUTH_PROVIDERS } = require("../config/constants");

async function seedAdmin() {
  const existing = await User.scope("withPassword").findOne({
    where: { email: env.ADMIN_EMAIL },
  });

  if (!existing) {
    await User.create({
      role: ROLES.ADMIN,
      name: env.ADMIN_NAME,
      email: env.ADMIN_EMAIL,
      passwordHash: await password.hash(env.ADMIN_PASSWORD),
      authProvider: AUTH_PROVIDERS.LOCAL,
      isEmailVerified: true,
      isActive: true,
    });
    console.log(`✅ Seeded admin ${env.ADMIN_EMAIL}`);
    return;
  }

  // Update the hash only if the .env password actually changed.
  const same = await password.compare(env.ADMIN_PASSWORD, existing.passwordHash || "");
  if (!same) {
    existing.passwordHash = await password.hash(env.ADMIN_PASSWORD);
    await existing.save();
    console.log("🔁 Admin password updated from .env");
  }
}

module.exports = seedAdmin;

// Allow `node src/seeders/admin.seeder.js` to run it directly.
if (require.main === module) {
  const { sequelize } = require("../models");
  seedAdmin()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Admin seed failed:", err);
      process.exit(1);
    });
}
