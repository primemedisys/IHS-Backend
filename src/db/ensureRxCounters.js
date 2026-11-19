/**
 * `rx_counters` hands out gapless per-doctor, per-year prescription numbers.
 * It has no Sequelize model (nothing reads it as an entity — utils/rxNumber.js
 * upserts it with raw SQL), so `sequelize.sync()` never creates it. Dev parity
 * lives here; production gets it from migration 006. Idempotent.
 */
module.exports = async function ensureRxCounters(sequelize) {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS rx_counters (
      doctor_id BIGINT UNSIGNED NOT NULL,
      year      SMALLINT UNSIGNED NOT NULL,
      next_val  INT UNSIGNED NOT NULL DEFAULT 1,
      PRIMARY KEY (doctor_id, year)
    ) ENGINE=InnoDB
  `);
};
