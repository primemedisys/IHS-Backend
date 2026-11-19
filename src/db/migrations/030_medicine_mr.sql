-- ============================================================================
-- 030 — Medicine & MR feature
--
-- Adds two new roles ('mr' and 'medicine_store') to users, plus four new
-- tables that back the medicine marketplace:
--
--   medicine_categories     — taxonomy for listing medicines
--   medicines               — individual products offered by MRs / stores
--   medicine_orders         — patient orders from providers
--   medicine_notifications  — push / in-app notifications per user
--
-- Idempotent (information_schema-guarded) like 013–029.
-- ============================================================================

-- ── 1. Widen users.role enum ───────────────────────────────────────────────
SET @hasMr := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
    AND COLUMN_TYPE LIKE '%mr%');
SET @ddl := IF(@hasMr = 0,
  "ALTER TABLE users MODIFY role ENUM('patient','doctor','admin','clinic','mr','medicine_store') NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. medicine_categories ─────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_categories');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_categories (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name       VARCHAR(150) NOT NULL,
     slug       VARCHAR(150) NOT NULL,
     created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mc_name (name),
     UNIQUE KEY uq_mc_slug (slug)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. medicine_store_medicines ─────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_store_medicines');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_store_medicines (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     category_id     INT UNSIGNED    NULL,
     medicine_name   VARCHAR(255)    NOT NULL,
     generic_name    VARCHAR(255)    NULL,
     medicine_type   VARCHAR(50)     NOT NULL,
     strength        VARCHAR(100)    NULL,
     manufacturer    VARCHAR(255)    NULL,
     description     TEXT            NULL,
     price           DECIMAL(10,2)   NOT NULL,
     stock           INT UNSIGNED    NOT NULL DEFAULT 0,
     location        VARCHAR(255)    NULL,
     image_url       VARCHAR(512)    NULL,
     is_active       TINYINT(1)      NOT NULL DEFAULT 1,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_med_provider    (provider_id, provider_type),
     KEY idx_med_category    (category_id),
     KEY idx_med_active      (is_active),
     CONSTRAINT fk_med_provider  FOREIGN KEY (provider_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_med_category  FOREIGN KEY (category_id)  REFERENCES medicine_categories (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. medicine_orders ─────────────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_orders');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_orders (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     patient_id      BIGINT UNSIGNED NOT NULL,
     provider_id     BIGINT UNSIGNED NOT NULL,
     provider_type   ENUM(''mr'',''medicine_store'') NOT NULL,
     medicine_id     BIGINT UNSIGNED NOT NULL,
     quantity        INT UNSIGNED    NOT NULL DEFAULT 1,
     unit_price      DECIMAL(10,2)   NOT NULL,
     total_price     DECIMAL(10,2)   NOT NULL,
     status          ENUM(''pending'',''confirmed'',''processing'',''shipped'',''delivered'',''rejected'',''cancelled'') NOT NULL DEFAULT ''pending'',
     payment_status  ENUM(''pending'',''paid'',''failed'',''refunded'') NOT NULL DEFAULT ''pending'',
     delivery_address TEXT           NULL,
     notes           TEXT            NULL,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mo_patient  (patient_id),
     KEY idx_mo_provider (provider_id, provider_type),
     KEY idx_mo_status   (status),
     CONSTRAINT fk_mo_patient  FOREIGN KEY (patient_id)  REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mo_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_mo_medicine FOREIGN KEY (medicine_id) REFERENCES medicine_store_medicines (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. medicine_notifications ──────────────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine_notifications');
SET @ddl := IF(@has = 0,
  'CREATE TABLE medicine_notifications (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id         BIGINT UNSIGNED NOT NULL,
     title           VARCHAR(255)    NOT NULL,
     message         TEXT            NOT NULL,
     type            VARCHAR(50)     NOT NULL,
     reference_id    BIGINT UNSIGNED NULL,
     reference_type  VARCHAR(50)     NULL,
     is_read         TINYINT(1)      NOT NULL DEFAULT 0,
     created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_mn_user   (user_id),
     KEY idx_mn_read   (is_read),
     CONSTRAINT fk_mn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
