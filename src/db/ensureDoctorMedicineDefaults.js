/**
 * Idempotent schema guard for migration 054 (default frequency / food
 * direction on the doctor's own medicine list). Safe on every boot: each
 * column is added only when missing; no row is touched.
 */
const COLUMNS = [
  ["default_frequency", "ALTER TABLE medicines ADD COLUMN default_frequency VARCHAR(100) NULL AFTER strength"],
  ["default_timing", "ALTER TABLE medicines ADD COLUMN default_timing VARCHAR(20) NULL AFTER default_frequency"],
];

module.exports = async function ensureDoctorMedicineDefaults(sequelize) {
  const [cols] = await sequelize.query(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines'"
  );
  if (!cols.length) return; // table not created yet (fresh DB before sync/migrate)
  const have = new Set(cols.map((r) => r.c));
  for (const [column, ddl] of COLUMNS) {
    if (!have.has(column)) await sequelize.query(ddl);
  }
};
