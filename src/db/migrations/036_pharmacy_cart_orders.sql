-- ============================================================================
-- 036 — Pharmacy provider types + cart, order groups, billing and payment
--
-- Everything here is ADDITIVE. No column is dropped, no enum value is removed,
-- no row is deleted or rewritten. Existing MR rows keep the literal value 'mr'
-- and every foreign key stays valid; "MR is no longer active" is enforced in
-- application code (ACTIVE_MEDICINE_PROVIDER_ROLES), never by touching data.
--
--   1. users.role                       += 'pharmacy_hospital'
--   2. *.provider_type                  += 'pharmacy_hospital'   (4 tables)
--   3. medicine_orders.status           += 'on_the_way'
--   4. medicine_cart_items              — the ONE cart (patient → inventory row)
--   5. medicine_order_groups            — one checkout = one order header/bill
--   6. medicine_orders.order_group_id   — existing per-medicine rows become the
--                                         group's lines (NULL on historical rows)
--   7. medicine_payments                — the swappable payment layer
--
-- Idempotent (information_schema-guarded) like 013–035.
-- ============================================================================

-- ── 1. users.role: add the Pharmacy Hospital provider role ──────────────────
-- 'mr' is KEPT so the 13 existing MR accounts remain readable and loggable-in.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. provider_type enums ──────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_store_medicines MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_orders MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_requests'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE prescription_requests MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories'
    AND COLUMN_NAME = 'provider_type' AND COLUMN_TYPE LIKE '%pharmacy_hospital%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_categories MODIFY COLUMN provider_type
     ENUM('mr','medicine_store','pharmacy_hospital') NULL",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine_orders.status: add ON THE WAY ───────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%on_the_way%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE medicine_orders MODIFY COLUMN status
     ENUM('pending','confirmed','processing','shipped','on_the_way','delivered','rejected','cancelled')
     NOT NULL DEFAULT 'pending'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_cart_items — the one and only cart ──────────────────────────
-- A line is (patient, provider inventory row). The inventory row already
-- carries the provider, the provider type and that provider's own price and
-- stock, so the cart can never mix one provider's medicine with another's
-- price. Nothing about money is stored here: price is read live at checkout.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_cart_items');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_cart_items (
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
     CONSTRAINT fk_mci_patient   FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mci_medicine  FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
     CONSTRAINT fk_mci_rx FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. medicine_order_groups — one checkout, one bill ───────────────────────
-- A checkout is split per provider, so a group is always exactly one patient
-- ordering from exactly one pharmacy. The money columns are what the BACKEND
-- computed; they are never accepted from a client. The delivery columns mirror
-- the structured Google location already on users/clinic_profiles.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups');
SET @ddl := IF(@has = 0,
  "CREATE TABLE medicine_order_groups (
     id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     order_number            VARCHAR(32)     NULL,
     patient_id              BIGINT UNSIGNED NOT NULL,
     provider_id             BIGINT UNSIGNED NOT NULL,
     provider_type           ENUM('mr','medicine_store','pharmacy_hospital') NOT NULL,
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
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 6. medicine_orders.order_group_id ───────────────────────────────────────
-- NULLable on purpose: the 4 pre-036 orders were placed one medicine at a time
-- and have no group. Every reader treats a NULL group as a single-line order.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'order_group_id');
SET @ddl := IF(@has = 0,
  'ALTER TABLE medicine_orders
     ADD COLUMN order_group_id BIGINT UNSIGNED NULL AFTER patient_id,
     ADD KEY idx_mo_group (order_group_id),
     ADD CONSTRAINT fk_mo_group FOREIGN KEY (order_group_id)
       REFERENCES medicine_order_groups (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 7. medicine_payments — the gateway-swappable payment layer ──────────────
-- One row per payment ATTEMPT on an order group. In this phase `gateway` is
-- always 'simulated' and `reference` is an obviously-synthetic SIM-… string —
-- nothing here is meant to look like a bank transaction. A real gateway later
-- adds its own gateway value plus its own id columns; orders and bills above
-- this table do not change.
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments');
SET @ddl := IF(@has = 0,
  "CREATE TABLE medicine_payments (
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
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
