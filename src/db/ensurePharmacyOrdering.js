/**
 * Idempotent schema guard for migration 036 (pharmacy provider types + cart,
 * order groups, billing and payment). Safe on every boot, in every
 * environment, like ensureMedicineMaster / ensurePrescriptionAvailability.
 *
 * Every step is ADDITIVE and guarded by information_schema:
 *
 *   1. widen users.role and the four provider_type enums with the new
 *      'pharmacy_hospital' value — 'mr' is kept, so no existing row changes;
 *   2. widen medicine_orders.status with 'on_the_way';
 *   3. create medicine_cart_items, medicine_order_groups, medicine_payments;
 *   4. add medicine_orders.order_group_id (NULL on historical orders).
 *
 * Nothing is dropped, truncated, merged or back-filled. A table that
 * sequelize.sync() already created in dev is left exactly as it is; only the
 * columns/indexes it could not express are added.
 */

async function count(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return Number(rows[0].n);
}

/** Does this table exist in the connected schema? */
function hasTable(sequelize, db, table) {
  return count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table`,
    { db, table }
  );
}

/** Does `table.column` exist? */
function hasColumn(sequelize, db, table, column) {
  return count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { db, table, column }
  );
}

/** Does the enum on `table.column` already list `value`? */
function enumHasValue(sequelize, db, table, column, value) {
  return count(
    sequelize,
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table AND COLUMN_NAME = :column
         AND COLUMN_TYPE LIKE :needle`,
    { db, table, column, needle: `%'${value}'%` }
  );
}

/** Widen one enum column, but only when the table exists and the value is missing. */
async function widenEnum(sequelize, db, { table, column, value, ddl, label }) {
  if (!(await hasTable(sequelize, db, table))) return;
  if (await enumHasValue(sequelize, db, table, column, value)) return;
  await sequelize.query(ddl);
  console.log(`✅ ${label} (migration 036)`);
}

const PROVIDER_TYPE_ENUM = "ENUM('mr','medicine_store','pharmacy_hospital')";

module.exports = async function ensurePharmacyOrdering(sequelize) {
  const db = sequelize.getDatabaseName();

  // 1) users.role += pharmacy_hospital. Without this every Pharmacy Hospital
  //    signup fails with a data-truncation error (same failure mode the clinic
  //    role had — see ensureClinicRole).
  await widenEnum(sequelize, db, {
    table: "users",
    column: "role",
    value: "pharmacy_hospital",
    label: "Added 'pharmacy_hospital' to users.role",
    ddl: `ALTER TABLE users MODIFY COLUMN role
            ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital')
            NOT NULL DEFAULT 'patient'`,
  });

  // 2) provider_type on the four medicine tables.
  for (const [table, nullability] of [
    ["medicine_store_medicines", "NOT NULL"],
    ["medicine_orders", "NOT NULL"],
    ["prescription_requests", "NOT NULL"],
    ["medicine_categories", "NULL"],
  ]) {
    await widenEnum(sequelize, db, {
      table,
      column: "provider_type",
      value: "pharmacy_hospital",
      label: `Added 'pharmacy_hospital' to ${table}.provider_type`,
      ddl: `ALTER TABLE ${table} MODIFY COLUMN provider_type ${PROVIDER_TYPE_ENUM} ${nullability}`,
    });
  }

  // 3) medicine_orders.status += on_the_way.
  await widenEnum(sequelize, db, {
    table: "medicine_orders",
    column: "status",
    value: "on_the_way",
    label: "Added 'on_the_way' to medicine_orders.status",
    ddl: `ALTER TABLE medicine_orders MODIFY COLUMN status
            ENUM('pending','confirmed','processing','shipped','on_the_way','delivered','rejected','cancelled')
            NOT NULL DEFAULT 'pending'`,
  });

  // 4) The cart.
  if (!(await hasTable(sequelize, db, "medicine_cart_items"))) {
    await sequelize.query(`
      CREATE TABLE medicine_cart_items (
        id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        patient_id              BIGINT UNSIGNED NOT NULL,
        medicine_id             BIGINT UNSIGNED NOT NULL,
        quantity                INT UNSIGNED    NOT NULL DEFAULT 1,
        prescription_request_id BIGINT UNSIGNED NULL,
        created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mci_patient_medicine (patient_id, medicine_id),
        KEY idx_mci_patient (patient_id),
        CONSTRAINT fk_mci_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_mci_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
        CONSTRAINT fk_mci_rx FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log("✅ Created medicine_cart_items (migration 036)");
  }

  // 5) The order group / bill header.
  if (!(await hasTable(sequelize, db, "medicine_order_groups"))) {
    await sequelize.query(`
      CREATE TABLE medicine_order_groups (
        id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_number            VARCHAR(32)     NULL,
        patient_id              BIGINT UNSIGNED NOT NULL,
        provider_id             BIGINT UNSIGNED NOT NULL,
        provider_type           ${PROVIDER_TYPE_ENUM} NOT NULL,
        item_count              INT UNSIGNED    NOT NULL DEFAULT 0,
        subtotal                DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
        total_amount            DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
        payment_method          ENUM('cod','online') NOT NULL DEFAULT 'cod',
        payment_status          ENUM('pending','paid','failed','refunded') NOT NULL DEFAULT 'pending',
        status                  ENUM('pending','confirmed','processing','shipped','on_the_way','delivered','rejected','cancelled') NOT NULL DEFAULT 'pending',
        delivery_address        VARCHAR(500)    NULL,
        delivery_city           VARCHAR(100)    NULL,
        delivery_state          VARCHAR(100)    NULL,
        delivery_pincode        VARCHAR(20)     NULL,
        delivery_lat            DECIMAL(10,7)   NULL,
        delivery_lng            DECIMAL(10,7)   NULL,
        notes                   VARCHAR(500)    NULL,
        prescription_request_id BIGINT UNSIGNED NULL,
        placed_at               DATETIME        NULL,
        created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mog_number (order_number),
        KEY idx_mog_patient (patient_id),
        KEY idx_mog_provider (provider_id, status),
        CONSTRAINT fk_mog_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_mog_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_mog_rx FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log("✅ Created medicine_order_groups (migration 036)");
  }

  // 6) Link the existing per-medicine order rows to a group. NULL on the
  //    historical rows — they were placed before groups existed and are never
  //    rewritten.
  if (
    (await hasTable(sequelize, db, "medicine_orders")) &&
    !(await hasColumn(sequelize, db, "medicine_orders", "order_group_id"))
  ) {
    await sequelize.query(`
      ALTER TABLE medicine_orders
        ADD COLUMN order_group_id BIGINT UNSIGNED NULL AFTER patient_id,
        ADD KEY idx_mo_group (order_group_id),
        ADD CONSTRAINT fk_mo_group FOREIGN KEY (order_group_id)
          REFERENCES medicine_order_groups (id) ON DELETE SET NULL`);
    console.log("✅ Added medicine_orders.order_group_id (migration 036)");
  }

  // 7) The payment layer.
  if (!(await hasTable(sequelize, db, "medicine_payments"))) {
    await sequelize.query(`
      CREATE TABLE medicine_payments (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_group_id  BIGINT UNSIGNED NOT NULL,
        amount          DECIMAL(10,2)   NOT NULL,
        method          ENUM('cod','online') NOT NULL,
        status          ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
        gateway         VARCHAR(30)     NOT NULL DEFAULT 'simulated',
        reference       VARCHAR(100)    NULL,
        idempotency_key VARCHAR(100)    NULL,
        failure_reason  VARCHAR(255)    NULL,
        paid_at         DATETIME        NULL,
        created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mp_idempotency (idempotency_key),
        KEY idx_mp_group (order_group_id),
        CONSTRAINT fk_mp_group FOREIGN KEY (order_group_id)
          REFERENCES medicine_order_groups (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log("✅ Created medicine_payments (migration 036)");
  }
};
