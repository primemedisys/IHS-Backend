/**
 * Dev-only parity shim for the medicine_categories provider-ownership columns.
 *
 * Migration 031 adds provider_id / provider_type to medicine_categories.
 * On an existing dev database the table exists without those columns, so
 * sequelize.sync() fails when it tries to create an index on them.
 *
 * This runs BEFORE sync() to add the columns and indexes idempotently.
 */
const { QueryTypes } = require("sequelize");

async function ensureCategoryProviderColumns(sequelize) {
  const [{ c: hasCol }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE()
         AND table_name  = 'medicine_categories'
         AND column_name = 'provider_id'`,
    { type: QueryTypes.SELECT }
  );

  if (Number(hasCol) > 0) return false;

  // Add provider_id column
  await sequelize.query(
    `ALTER TABLE medicine_categories
       ADD COLUMN provider_id BIGINT UNSIGNED NULL AFTER slug`
  );

  // Add provider_type column
  await sequelize.query(
    `ALTER TABLE medicine_categories
       ADD COLUMN provider_type ENUM('mr','medicine_store') NULL AFTER provider_id`
  );

  // Add composite unique constraint: a provider cannot have duplicate category names
  const [{ i: hasUnique }] = await sequelize.query(
    `SELECT COUNT(*) AS i FROM information_schema.STATISTICS
       WHERE table_schema = DATABASE()
         AND table_name  = 'medicine_categories'
         AND index_name  = 'uq_mc_provider_name'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(hasUnique) === 0) {
    await sequelize.query(
      `ALTER TABLE medicine_categories
         ADD UNIQUE KEY uq_mc_provider_name (provider_id, name)`
    );
  }

  // Add index for provider lookup
  const [{ i: hasIdx }] = await sequelize.query(
    `SELECT COUNT(*) AS i FROM information_schema.STATISTICS
       WHERE table_schema = DATABASE()
         AND table_name  = 'medicine_categories'
         AND index_name  = 'idx_mc_provider'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(hasIdx) === 0) {
    await sequelize.query(
      `ALTER TABLE medicine_categories
         ADD INDEX idx_mc_provider (provider_id, provider_type)`
    );
  }

  console.log("➕ Added medicine_categories provider-ownership columns");
  return true;
}

module.exports = ensureCategoryProviderColumns;
