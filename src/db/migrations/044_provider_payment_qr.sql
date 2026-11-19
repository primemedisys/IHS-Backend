-- ============================================================================
-- 044 — Provider UPI QR payments
--
-- A doctor or a pharmacy uploads its OWN UPI QR code; a patient pays it from
-- any UPI app and may report "I have paid" with the UPI transaction id. The
-- platform never treats that as proof: the payment stays pending until the
-- PROVIDER confirms the money reached them (doctor: the existing mark-paid;
-- pharmacy: confirm-received). No gateway, no money through the platform.
--
--   provider_payment_qr   — one row per provider user: QR image URL, UPI id,
--                           payee name, active flag
--   payments              += offline_method ('cash' | 'upi_qr'),
--                            payer_reference, payer_reported_at
--   medicine_order_groups.payment_method += 'upi_qr'
--   medicine_payments.method             += 'upi_qr'
--   medicine_payments     += payer_reference, payer_reported_at
--   (medicine_payments.gateway is a VARCHAR — 'manual_upi' needs no DDL)
--
-- ADDITIVE ONLY: no column is dropped, renamed or narrowed; the two ENUMs are
-- widened with a NEW trailing value (every existing value and the default are
-- kept), so no existing row changes. Existing offline booking payments keep
-- offline_method NULL, which every reader treats as cash.
--
-- Idempotent (IF NOT EXISTS + information_schema-guarded) like 043. The same
-- DDL runs at boot from src/db/ensurePaymentQr.js, which reads the CREATE
-- TABLE statement straight out of this file.
-- ============================================================================

-- ── 1. provider_payment_qr ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_payment_qr (
  user_id      BIGINT UNSIGNED NOT NULL,
  qr_image_url VARCHAR(500)    NULL,
  upi_id       VARCHAR(100)    NULL,
  payee_name   VARCHAR(150)    NULL,
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_ppq_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. payments (doctor bookings) ───────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'offline_method');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN offline_method ENUM(''cash'',''upi_qr'') NULL AFTER mode', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'payer_reference');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN payer_reference VARCHAR(64) NULL AFTER offline_method', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'payer_reported_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE payments ADD COLUMN payer_reported_at DATETIME NULL AFTER payer_reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine orders: widen the payment-method enums with 'upi_qr' ────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_order_groups' AND COLUMN_NAME = 'payment_method'
    AND COLUMN_TYPE NOT LIKE '%''upi_qr''%');
SET @ddl := IF(@has = 1, 'ALTER TABLE medicine_order_groups MODIFY COLUMN payment_method ENUM(''cod'',''online'',''upi_qr'') NOT NULL DEFAULT ''cod''', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'method'
    AND COLUMN_TYPE NOT LIKE '%''upi_qr''%');
SET @ddl := IF(@has = 1, 'ALTER TABLE medicine_payments MODIFY COLUMN method ENUM(''cod'',''online'',''upi_qr'') NOT NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_payments: what the patient reported ─────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'payer_reference');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_payments ADD COLUMN payer_reference VARCHAR(64) NULL AFTER reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_payments' AND COLUMN_NAME = 'payer_reported_at');
SET @ddl := IF(@has = 0, 'ALTER TABLE medicine_payments ADD COLUMN payer_reported_at DATETIME NULL AFTER payer_reference', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
