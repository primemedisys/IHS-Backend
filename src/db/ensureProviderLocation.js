/**
 * Idempotent schema guard for migration 034 (provider location on users):
 * adds the structured Google-location columns to the long-lived `users` table.
 * `sequelize.sync()` creates them for brand-new databases (the User model
 * declares them) but will never ALTER an existing users table, so this probe
 * fills the gap in dev. Same pattern as ensureVitalsLocation.
 *
 * All columns nullable, no backfill — legacy MR/Store rows keep NULL and only
 * new Google-selected registrations populate these fields.
 */
module.exports = async function ensureProviderLocation(sequelize) {
  const db = sequelize.getDatabaseName();

  const columns = [
    ["address_line", "VARCHAR(255) NULL AFTER profile_photo_url"],
    ["city", "VARCHAR(100) NULL AFTER address_line"],
    ["state", "VARCHAR(100) NULL AFTER city"],
    ["pincode", "VARCHAR(20) NULL AFTER state"],
    ["lat", "DECIMAL(10,7) NULL AFTER pincode"],
    ["lng", "DECIMAL(10,7) NULL AFTER lat"],
  ];

  for (const [column, definition] of columns) {
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'users' AND COLUMN_NAME = :column`,
      { replacements: { db, column } }
    );
    if (Number(rows[0].n)) continue;
    await sequelize.query(
      `ALTER TABLE users ADD COLUMN ${column} ${definition}`
    );
    console.log(`✅ Added users.${column} (migration 034)`);
  }
};