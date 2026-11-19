-- ============================================================================
-- 033 — Prescription availability flow
--
-- Adds `prescription_request_items` (a provider's per-medicine availability
-- answer for a shared prescription) and links `medicine_orders` back to the
-- prescription request they were placed from.
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_request_items');
SET @ddl := IF(@has = 0,
  'CREATE TABLE prescription_request_items (
     id                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
     prescription_request_id BIGINT UNSIGNED  NOT NULL,
     medicine_id             BIGINT UNSIGNED  NULL,
     medicine_name           VARCHAR(255)     NOT NULL,
     quantity                INT UNSIGNED     NULL,
     price                   DECIMAL(10,2)    NULL,
     status                  ENUM(''available'',''unavailable'') NOT NULL,
     reason                  VARCHAR(255)     NULL,
     created_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_pri_request (prescription_request_id),
     KEY idx_pri_status  (status),
     CONSTRAINT fk_pri_request  FOREIGN KEY (prescription_request_id) REFERENCES prescription_requests (id) ON DELETE CASCADE,
     CONSTRAINT fk_pri_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Link orders placed off a shared prescription back to that request.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'medicine_orders'
    AND COLUMN_NAME = 'prescription_request_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE medicine_orders
     ADD COLUMN prescription_request_id BIGINT UNSIGNED NULL AFTER notes,
     ADD KEY idx_mo_prescription (prescription_request_id),
     ADD CONSTRAINT fk_mo_prescription FOREIGN KEY (prescription_request_id)
       REFERENCES prescription_requests (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;