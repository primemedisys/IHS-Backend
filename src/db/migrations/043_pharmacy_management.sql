-- ============================================================================
-- 043 — Pharmacy management: pricing/GST on inventory, batches + expiry,
--       stock ledger, suppliers, purchases, returns / credit notes, settings
--
-- Builds on the EXISTING medicine architecture without duplicating it:
--
--   medicine_store_medicines   (inventory)  += sku, hsn, pack, MRP, buying
--                                              price, GST %, discount %,
--                                              reorder level, nearest-expiry
--                                              batch summary, last supplier
--   medicine_orders            (order lines) += price / discount / GST / cost
--                                              snapshot at the time of sale
--   medicine_order_groups      (the bill)    += discount and GST totals
--
--   pharmacy_suppliers         — a pharmacy's own suppliers
--   medicine_stock_batches     — batch-wise stock of one inventory row
--   pharmacy_purchases / _items— supplier purchase invoices (stock IN)
--   medicine_returns / _items  — returns against delivered orders (credit notes)
--   medicine_stock_movements   — the stock ledger: every change, with its cause
--   pharmacy_profiles          — GSTIN / drug licence / expiry window per pharmacy
--
-- Invariant kept by services/pharmacyStock.service.js:
--   inventory.stock = Σ batch.quantity_available + untracked (pre-batch) units
--
-- ADDITIVE ONLY: nothing is dropped, renamed or narrowed; no row is deleted
-- or rewritten. Existing inventory rows get GST 0, discount 0 and reorder
-- level 10 (the admin tracker's existing low-stock figure) until edited.
--
-- Numbering: 041 / 042 are not in this branch on purpose. Development
-- databases already recorded `041_home_care.sql` (another branch) and an
-- earlier draft `042_pharmacy_management.sql` in _migrations; re-using either
-- id would make `npm run migrate` silently skip this file there. The columns
-- the 042 draft created without are reconciled by the guarded ALTERs below.
--
-- Idempotent (IF NOT EXISTS + information_schema-guarded) like 013–040. The
-- same DDL runs at boot from src/db/ensurePharmacyManagement.js, which reads
-- the CREATE TABLE statements straight out of this file.
-- ============================================================================

-- ── 1. pharmacy_suppliers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pharmacy_suppliers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id    BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(200)    NOT NULL,
  contact_person VARCHAR(150)    NULL,
  phone          VARCHAR(20)     NULL,
  email          VARCHAR(255)    NULL,
  address        VARCHAR(500)    NULL,
  gstin          VARCHAR(15)     NULL,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ps_provider_name (provider_id, name),
  CONSTRAINT fk_ps_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. medicine_stock_batches ───────────────────────────────────────────────
-- One row per (inventory row, batch number). The collation is case-insensitive
-- and the service upper-cases batch numbers, so "b12" and "B12" are one batch.
CREATE TABLE IF NOT EXISTS medicine_stock_batches (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id        BIGINT UNSIGNED NOT NULL,
  inventory_id       BIGINT UNSIGNED NOT NULL,
  batch_number       VARCHAR(64)     NOT NULL,
  expiry_date        DATE            NULL,
  quantity_received  INT UNSIGNED    NOT NULL DEFAULT 0,
  quantity_available INT UNSIGNED    NOT NULL DEFAULT 0,
  buying_price       DECIMAL(10,2)   NULL,
  mrp                DECIMAL(10,2)   NULL,
  supplier_id        BIGINT UNSIGNED NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_msb_inventory_batch (inventory_id, batch_number),
  KEY idx_msb_provider_expiry (provider_id, expiry_date),
  KEY idx_msb_supplier (supplier_id),
  CONSTRAINT fk_msb_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)                    ON DELETE CASCADE,
  CONSTRAINT fk_msb_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
  CONSTRAINT fk_msb_supplier  FOREIGN KEY (supplier_id)  REFERENCES pharmacy_suppliers (id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. pharmacy_purchases — one supplier invoice ────────────────────────────
-- Money columns are what the BACKEND computed from the lines; never client totals.
CREATE TABLE IF NOT EXISTS pharmacy_purchases (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_number VARCHAR(32)     NULL,
  provider_id     BIGINT UNSIGNED NOT NULL,
  supplier_id     BIGINT UNSIGNED NULL,
  invoice_number  VARCHAR(64)     NOT NULL,
  invoice_date    DATE            NOT NULL,
  status          ENUM('received','cancelled') NOT NULL DEFAULT 'received',
  cancelled_at    DATETIME        NULL,
  item_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  subtotal        DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  discount_total  DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  taxable_total   DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  gst_total       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  total_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  notes           VARCHAR(500)    NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pp_number (purchase_number),
  KEY idx_pp_provider_date (provider_id, invoice_date),
  KEY idx_pp_supplier (supplier_id),
  CONSTRAINT fk_pp_provider FOREIGN KEY (provider_id) REFERENCES users (id)              ON DELETE CASCADE,
  CONSTRAINT fk_pp_supplier FOREIGN KEY (supplier_id) REFERENCES pharmacy_suppliers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. pharmacy_purchase_items — one medicine line on a purchase ────────────
CREATE TABLE IF NOT EXISTS pharmacy_purchase_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_id        BIGINT UNSIGNED NOT NULL,
  inventory_id       BIGINT UNSIGNED NULL,
  batch_id           BIGINT UNSIGNED NULL,
  medicine_master_id BIGINT UNSIGNED NULL,
  medicine_name      VARCHAR(255)    NOT NULL,
  batch_number       VARCHAR(64)     NULL,
  expiry_date        DATE            NULL,
  quantity           INT UNSIGNED    NOT NULL,
  free_quantity      INT UNSIGNED    NOT NULL DEFAULT 0,
  buying_price       DECIMAL(10,2)   NOT NULL,
  mrp                DECIMAL(10,2)   NULL,
  selling_price      DECIMAL(10,2)   NULL,
  gst_rate           DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  discount_percent   DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  gross_amount       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  discount_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  taxable_amount     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  gst_amount         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  line_total         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ppi_purchase (purchase_id),
  KEY idx_ppi_inventory (inventory_id),
  KEY idx_ppi_batch (batch_id),
  CONSTRAINT fk_ppi_purchase  FOREIGN KEY (purchase_id)  REFERENCES pharmacy_purchases (id)       ON DELETE CASCADE,
  CONSTRAINT fk_ppi_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE SET NULL,
  CONSTRAINT fk_ppi_batch     FOREIGN KEY (batch_id)     REFERENCES medicine_stock_batches (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. medicine_returns — a credit note against one delivered order ─────────
CREATE TABLE IF NOT EXISTS medicine_returns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_note_number VARCHAR(32)     NULL,
  order_group_id     BIGINT UNSIGNED NOT NULL,
  provider_id        BIGINT UNSIGNED NOT NULL,
  patient_id         BIGINT UNSIGNED NOT NULL,
  reason             VARCHAR(500)    NULL,
  restocked          TINYINT(1)      NOT NULL DEFAULT 1,
  item_count         INT UNSIGNED    NOT NULL DEFAULT 0,
  taxable_total      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  gst_total          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  refund_amount      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mr_credit_note (credit_note_number),
  KEY idx_mr_provider_date (provider_id, created_at),
  KEY idx_mr_group (order_group_id),
  CONSTRAINT fk_mr_group    FOREIGN KEY (order_group_id) REFERENCES medicine_order_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_mr_provider FOREIGN KEY (provider_id)    REFERENCES users (id)                 ON DELETE CASCADE,
  CONSTRAINT fk_mr_patient  FOREIGN KEY (patient_id)     REFERENCES users (id)                 ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6. medicine_return_items — returned quantity of one order line ──────────
CREATE TABLE IF NOT EXISTS medicine_return_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id      BIGINT UNSIGNED NOT NULL,
  order_line_id  BIGINT UNSIGNED NOT NULL,
  medicine_id    BIGINT UNSIGNED NULL,
  medicine_name  VARCHAR(255)    NOT NULL,
  quantity       INT UNSIGNED    NOT NULL,
  unit_price     DECIMAL(10,2)   NOT NULL,
  gst_rate       DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  taxable_amount DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  gst_amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  line_total     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mri_return (return_id),
  KEY idx_mri_line (order_line_id),
  CONSTRAINT fk_mri_return   FOREIGN KEY (return_id)     REFERENCES medicine_returns (id)         ON DELETE CASCADE,
  CONSTRAINT fk_mri_line     FOREIGN KEY (order_line_id) REFERENCES medicine_orders (id)          ON DELETE CASCADE,
  CONSTRAINT fk_mri_medicine FOREIGN KEY (medicine_id)   REFERENCES medicine_store_medicines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 7. medicine_stock_movements — the stock ledger ──────────────────────────
-- Signed quantity (+in / −out) and the stock level right after it. A sale's
-- rows also record WHICH batch each unit came from, which is how a cancel or a
-- return puts units back on exactly the batch they left.
CREATE TABLE IF NOT EXISTS medicine_stock_movements (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id    BIGINT UNSIGNED NOT NULL,
  inventory_id   BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,
  movement_type  ENUM('opening','purchase','purchase_cancel','sale','sale_reversal','return','adjustment','import','expiry_writeoff') NOT NULL,
  quantity       INT             NOT NULL,
  stock_after    INT UNSIGNED    NOT NULL,
  reference_type VARCHAR(30)     NULL,
  reference_id   BIGINT UNSIGNED NULL,
  note           VARCHAR(255)    NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_msmv_inventory (inventory_id, created_at),
  KEY idx_msmv_reference (reference_type, reference_id),
  KEY idx_msmv_provider (provider_id, created_at),
  KEY idx_msmv_batch (batch_id),
  CONSTRAINT fk_msmv_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)                    ON DELETE CASCADE,
  CONSTRAINT fk_msmv_inventory FOREIGN KEY (inventory_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE,
  CONSTRAINT fk_msmv_batch     FOREIGN KEY (batch_id)     REFERENCES medicine_stock_batches (id)   ON DELETE SET NULL,
  CONSTRAINT fk_msmv_creator   FOREIGN KEY (created_by)   REFERENCES users (id)                    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 8. pharmacy_profiles — the store's tax / licence details + preferences ──
CREATE TABLE IF NOT EXISTS pharmacy_profiles (
  provider_id         BIGINT UNSIGNED   NOT NULL,
  gstin               VARCHAR(15)       NULL,
  drug_license_number VARCHAR(64)       NULL,
  expiry_alert_days   SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  invoice_note        VARCHAR(500)      NULL,
  created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_id),
  CONSTRAINT fk_pprof_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 9. Columns on existing tables ───────────────────────────────────────────
-- (A table created above already has them; these only fire on older tables.)

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'sku');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN sku VARCHAR(64) NULL AFTER medicine_master_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'hsn_code');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN hsn_code VARCHAR(20) NULL AFTER description', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'pack_size');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN pack_size VARCHAR(50) NULL AFTER hsn_code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'mrp');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN mrp DECIMAL(10,2) NULL AFTER pack_size', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'buying_price');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN buying_price DECIMAL(10,2) NULL AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'gst_rate');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER price', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'discount_percent');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER gst_rate', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'min_stock');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN min_stock INT UNSIGNED NOT NULL DEFAULT 10 AFTER stock', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'batch_number');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN batch_number VARCHAR(64) NULL AFTER min_stock', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'expiry_date');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN expiry_date DATE NULL AFTER batch_number', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND COLUMN_NAME = 'supplier_id');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD COLUMN supplier_id BIGINT UNSIGNED NULL AFTER expiry_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'mrp');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN mrp DECIMAL(10,2) NULL AFTER unit_price', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'discount_percent');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'discount_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_percent', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'gst_rate');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER discount_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'taxable_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN taxable_amount DECIMAL(10,2) NULL AFTER gst_rate', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'gst_amount');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN gst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'unit_cost');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN unit_cost DECIMAL(10,2) NULL AFTER gst_amount', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'hsn_code');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN hsn_code VARCHAR(20) NULL AFTER unit_cost', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'batch_number');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN batch_number VARCHAR(64) NULL AFTER hsn_code', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders' AND COLUMN_NAME = 'expiry_date');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_orders ADD COLUMN expiry_date DATE NULL AFTER batch_number', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'discount_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN discount_total DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER subtotal', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'taxable_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN taxable_total DECIMAL(10,2) NULL AFTER discount_total', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'gst_total');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD COLUMN gst_total DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER taxable_total', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchases' AND COLUMN_NAME = 'status');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchases ADD COLUMN status ENUM(''received'',''cancelled'') NOT NULL DEFAULT ''received'' AFTER invoice_date', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchases' AND COLUMN_NAME = 'cancelled_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchases ADD COLUMN cancelled_at DATETIME NULL AFTER status', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND COLUMN_NAME = 'batch_id');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD COLUMN batch_id BIGINT UNSIGNED NULL AFTER inventory_id', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND COLUMN_NAME = 'selling_price');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD COLUMN selling_price DECIMAL(10,2) NULL AFTER mrp', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 10. Indexes ──────────────────────────────────────────────────────────────

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_provider_active');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_provider_active (provider_id, is_active)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_provider_expiry');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_provider_expiry (provider_id, expiry_date)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND INDEX_NAME = 'idx_msm_supplier');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD INDEX idx_msm_supplier (supplier_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND INDEX_NAME = 'idx_mog_provider_placed');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_order_groups ADD INDEX idx_mog_provider_placed (provider_id, placed_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND INDEX_NAME = 'idx_ppi_batch');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD INDEX idx_ppi_batch (batch_id)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 11. Foreign keys ─────────────────────────────────────────────────────────

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines' AND CONSTRAINT_NAME = 'fk_msm_supplier');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_store_medicines ADD CONSTRAINT fk_msm_supplier FOREIGN KEY (supplier_id) REFERENCES pharmacy_suppliers (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pharmacy_purchase_items' AND CONSTRAINT_NAME = 'fk_ppi_batch');
SET @ddl := IF(@has = 0, 'ALTER TABLE pharmacy_purchase_items ADD CONSTRAINT fk_ppi_batch FOREIGN KEY (batch_id) REFERENCES medicine_stock_batches (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
