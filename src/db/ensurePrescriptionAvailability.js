/**
 * Idempotent schema guard for migration 033 (prescription availability):
 * creates `prescription_request_items` and links `medicine_orders` back to the
 * prescription request. Probes information_schema and returns early — safe to
 * run on every boot, in every environment, exactly like ensureQueueColumns.
 *
 * sequelize.sync() creates the brand-new items table by itself, so this guard
 * mostly matters for the ALTER on the long-lived medicine_orders table, which
 * sync() will never touch.
 */
module.exports = async function ensurePrescriptionAvailability(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) prescription_request_items (mirrors src/db/migrations/033).
  const [tables] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'prescription_request_items'`,
    { replacements: { db } }
  );
  if (!Number(tables[0].n)) {
    await sequelize.query(`
      CREATE TABLE prescription_request_items (
        id                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        prescription_request_id BIGINT UNSIGNED  NOT NULL,
        medicine_id             BIGINT UNSIGNED  NULL,
        medicine_name           VARCHAR(255)     NOT NULL,
        quantity                INT UNSIGNED     NULL,
        price                   DECIMAL(10,2)    NULL,
        status                  ENUM('available','unavailable') NOT NULL,
        reason                  VARCHAR(255)     NULL,
        created_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pri_request (prescription_request_id),
        KEY idx_pri_status  (status),
        CONSTRAINT fk_pri_request  FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE CASCADE,
        CONSTRAINT fk_pri_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log("✅ Created prescription_request_items (migration 033)");
  }

  // 2) medicine_orders.prescription_request_id (sync() won't ALTER an old table).
  const [cols] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'prescription_request_id'`,
    { replacements: { db } }
  );
  if (!Number(cols[0].n)) {
    await sequelize.query(`
      ALTER TABLE medicine_orders
        ADD COLUMN prescription_request_id BIGINT UNSIGNED NULL AFTER notes,
        ADD KEY idx_mo_prescription (prescription_request_id),
        ADD CONSTRAINT fk_mo_prescription FOREIGN KEY (prescription_request_id)
          REFERENCES prescription_requests (id) ON DELETE SET NULL`);
    console.log("✅ Added medicine_orders.prescription_request_id (migration 033)");
  }
};