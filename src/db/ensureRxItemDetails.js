/**
 * Idempotent schema guard for migration 053 (structured medicine details on
 * prescription lines). Safe on every boot: each column / constraint is added
 * only when missing, and no row is touched. Runs after sync() so a brand-new
 * dev database (whose tables sync() just created) gets them too.
 */
const COLUMNS = [
  ["prescription_items", "strength", "ALTER TABLE prescription_items ADD COLUMN strength VARCHAR(100) NULL AFTER medicine_name"],
  ["prescription_items", "dosage_form", "ALTER TABLE prescription_items ADD COLUMN dosage_form VARCHAR(50) NULL AFTER strength"],
  ["prescription_items", "medicine_master_id", "ALTER TABLE prescription_items ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER medicine_id"],
  ["medicines", "dosage_form", "ALTER TABLE medicines ADD COLUMN dosage_form VARCHAR(50) NULL AFTER form"],
];
const FK = "fk_rxitem_medicine_master";

module.exports = async function ensureRxItemDetails(sequelize) {
  const [cols] = await sequelize.query(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('prescription_items', 'medicines', 'medicine_masters')"
  );
  const tables = new Set(cols.map((r) => r.t));
  // Nothing to patch until the tables exist (a fresh DB before sync/migrate).
  if (!tables.has("prescription_items") || !tables.has("medicines")) return;
  const have = new Set(cols.map((r) => `${r.t}.${r.c}`));
  for (const [table, column, ddl] of COLUMNS) {
    if (!have.has(`${table}.${column}`)) await sequelize.query(ddl);
  }
  if (!tables.has("medicine_masters")) return;
  const [fk] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_items' AND CONSTRAINT_NAME = :fk",
    { replacements: { fk: FK } }
  );
  if (!Number(fk[0].n)) {
    await sequelize.query(
      `ALTER TABLE prescription_items ADD CONSTRAINT ${FK} FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE SET NULL`
    );
  }
};
