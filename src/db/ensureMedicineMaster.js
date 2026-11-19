/**
 * Idempotent schema guard + one-time backfill for migration 035 (global
 * medicine master). Safe on every boot, in every environment, like
 * ensurePrescriptionAvailability:
 *
 *   1. creates `medicine_masters` if missing (sync() does it in dev already);
 *   2. adds `medicine_store_medicines.medicine_master_id` (sync() never ALTERs
 *      a long-lived table);
 *   3. links every inventory row that has no master yet to the master with the
 *      same normalized NAME|STRENGTH|TYPE identity, creating that master from
 *      the oldest such row when none exists.
 *
 * Step 3 is additive only: it never deletes or merges inventory rows, never
 * touches price/stock, and only ever writes rows whose master id is NULL — so
 * a provider's pre-existing duplicate rows simply end up pointing at the same
 * master and are reported, not removed.
 */
const { medicineIdentityKey, cleanDisplay } = require("../utils/medicineIdentity");

async function count(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return Number(rows[0].n);
}

module.exports = async function ensureMedicineMaster(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) medicine_masters (mirrors src/db/migrations/035).
  const hasTable = await count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'medicine_masters'`,
    { db }
  );
  if (!hasTable) {
    await sequelize.query(`
      CREATE TABLE medicine_masters (
        id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        medicine_name  VARCHAR(255)    NOT NULL,
        generic_name   VARCHAR(255)    NULL,
        medicine_type  VARCHAR(50)     NOT NULL,
        strength       VARCHAR(100)    NULL,
        manufacturer   VARCHAR(255)    NULL,
        description    TEXT            NULL,
        category_id    INT UNSIGNED    NULL,
        identity_key   VARCHAR(420)    NOT NULL,
        created_by     BIGINT UNSIGNED NULL,
        is_active      TINYINT(1)      NOT NULL DEFAULT 1,
        created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mm_identity (identity_key),
        KEY idx_mm_name     (medicine_name),
        KEY idx_mm_category (category_id),
        CONSTRAINT fk_mm_category FOREIGN KEY (category_id) REFERENCES medicine_categories (id) ON DELETE SET NULL,
        CONSTRAINT fk_mm_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log("✅ Created medicine_masters (migration 035)");
  }

  // 2) medicine_store_medicines.medicine_master_id.
  const hasCol = await count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'medicine_store_medicines'
         AND COLUMN_NAME = 'medicine_master_id'`,
    { db }
  );
  if (!hasCol) {
    await sequelize.query(`
      ALTER TABLE medicine_store_medicines
        ADD COLUMN medicine_master_id BIGINT UNSIGNED NULL AFTER category_id,
        ADD KEY idx_msm_master (medicine_master_id),
        ADD KEY idx_msm_provider_master (provider_id, medicine_master_id),
        ADD CONSTRAINT fk_msm_master FOREIGN KEY (medicine_master_id)
          REFERENCES medicine_masters (id) ON DELETE SET NULL`);
    console.log("✅ Added medicine_store_medicines.medicine_master_id (migration 035)");
  }

  // 3) Link unlinked inventory rows to their master (additive backfill).
  const [unlinked] = await sequelize.query(
    `SELECT id, provider_id, category_id, medicine_name, generic_name, medicine_type,
            strength, manufacturer, description
       FROM medicine_store_medicines
      WHERE medicine_master_id IS NULL
      ORDER BY id`
  );
  if (!unlinked.length) return;

  // Oldest row per identity is the representative the master is created from.
  const byKey = new Map();
  for (const row of unlinked) {
    const key = medicineIdentityKey({
      medicineName: row.medicine_name,
      strength: row.strength,
      medicineType: row.medicine_type,
    });
    if (!byKey.has(key)) byKey.set(key, { rep: row, ids: [] });
    byKey.get(key).ids.push(row.id);
  }
  const keys = [...byKey.keys()];

  await sequelize.transaction(async (transaction) => {
    const [existing] = await sequelize.query(
      "SELECT identity_key FROM medicine_masters WHERE identity_key IN (:keys)",
      { replacements: { keys }, transaction }
    );
    const have = new Set(existing.map((r) => r.identity_key));
    const missing = keys.filter((k) => !have.has(k));

    if (missing.length) {
      const values = [];
      const replacements = {};
      missing.forEach((key, i) => {
        const r = byKey.get(key).rep;
        values.push(`(:n${i}, :g${i}, :t${i}, :s${i}, :m${i}, :d${i}, :c${i}, :k${i}, :u${i}, NOW(), NOW())`);
        Object.assign(replacements, {
          [`n${i}`]: cleanDisplay(r.medicine_name),
          [`g${i}`]: r.generic_name || null,
          [`t${i}`]: cleanDisplay(r.medicine_type),
          [`s${i}`]: r.strength ? cleanDisplay(r.strength) : null,
          [`m${i}`]: r.manufacturer || null,
          [`d${i}`]: r.description || null,
          [`c${i}`]: r.category_id || null,
          [`k${i}`]: key,
          [`u${i}`]: r.provider_id || null,
        });
      });
      // INSERT IGNORE: a concurrent boot/request that created the same identity
      // first wins; we then just link to it below. Timestamps are explicit:
      // a sync()-created table has no column DEFAULTs.
      await sequelize.query(
        `INSERT IGNORE INTO medicine_masters
           (medicine_name, generic_name, medicine_type, strength, manufacturer,
            description, category_id, identity_key, created_by, created_at, updated_at)
         VALUES ${values.join(", ")}`,
        { replacements, transaction }
      );
    }

    const [masters] = await sequelize.query(
      "SELECT id, identity_key FROM medicine_masters WHERE identity_key IN (:keys)",
      { replacements: { keys }, transaction }
    );
    const masterIdByKey = new Map(masters.map((m) => [m.identity_key, m.id]));

    const cases = [];
    const replacements = { ids: [] };
    keys.forEach((key, i) => {
      const masterId = masterIdByKey.get(key);
      if (!masterId) return;
      for (const id of byKey.get(key).ids) {
        cases.push(`WHEN :r${replacements.ids.length} THEN :m${i}`);
        replacements[`r${replacements.ids.length}`] = id;
        replacements.ids.push(id);
      }
      replacements[`m${i}`] = masterId;
    });
    if (!replacements.ids.length) return;

    await sequelize.query(
      `UPDATE medicine_store_medicines
          SET medicine_master_id = CASE id ${cases.join(" ")} END
        WHERE id IN (:ids) AND medicine_master_id IS NULL`,
      { replacements, transaction }
    );
    console.log(
      `✅ Linked ${replacements.ids.length} inventory row(s) to ${masterIdByKey.size} medicine master(s) (migration 035)`
    );
  });
};
