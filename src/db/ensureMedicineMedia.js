/**
 * Idempotent schema guard for migration 037 (medicine images + substitutes).
 * Creates the two new tables when missing and returns early otherwise — safe
 * on every boot, in every environment, like ensurePrescriptionAvailability.
 * Additive only: it never alters or deletes an existing table or row.
 */
const TABLES = {
  medicine_master_images: `
    CREATE TABLE medicine_master_images (
      id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
      medicine_master_id  BIGINT UNSIGNED   NOT NULL,
      image_url           VARCHAR(512)      NOT NULL,
      storage_key         VARCHAR(512)      NULL,
      sort_order          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      uploaded_by         BIGINT UNSIGNED   NULL,
      created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_mmi_master_order (medicine_master_id, sort_order),
      CONSTRAINT fk_mmi_master   FOREIGN KEY (medicine_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
      CONSTRAINT fk_mmi_uploader FOREIGN KEY (uploaded_by)        REFERENCES users (id)            ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  medicine_master_substitutes: `
    CREATE TABLE medicine_master_substitutes (
      id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      medicine_master_id    BIGINT UNSIGNED NOT NULL,
      substitute_master_id  BIGINT UNSIGNED NOT NULL,
      created_by            BIGINT UNSIGNED NULL,
      created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_mms_pair (medicine_master_id, substitute_master_id),
      KEY idx_mms_substitute (substitute_master_id),
      CONSTRAINT fk_mms_master     FOREIGN KEY (medicine_master_id)   REFERENCES medicine_masters (id) ON DELETE CASCADE,
      CONSTRAINT fk_mms_substitute FOREIGN KEY (substitute_master_id) REFERENCES medicine_masters (id) ON DELETE CASCADE,
      CONSTRAINT fk_mms_creator    FOREIGN KEY (created_by)           REFERENCES users (id)            ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
};

module.exports = async function ensureMedicineMedia(sequelize) {
  const db = sequelize.getDatabaseName();
  const [rows] = await sequelize.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME IN (:names)`,
    { replacements: { db, names: Object.keys(TABLES) } }
  );
  const present = new Set(rows.map((r) => r.name));

  for (const [name, ddl] of Object.entries(TABLES)) {
    if (present.has(name)) continue;
    await sequelize.query(ddl);
    console.log(`✅ Created ${name} (migration 037)`);
  }
};
