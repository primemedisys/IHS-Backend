-- ============================================================================
-- 052 — Password reset OTP by EMAIL (extends 050)
--
-- 050 sends the 6-digit reset code by SMS only. This lets the same table carry
-- codes sent to the account's registered EMAIL too, so the doctor portal's
-- "Forgot password" works with email OR mobile through ONE code-based flow.
--
--   password_reset_otps
--     phone  NOT NULL → NULL      (an email-code row has no phone)
--     + email VARCHAR(190) NULL   (the normalised address the code was sent to)
--     + KEY idx_pro_email_created (email, created_at)  — per-address throttling
--
-- Exactly one of phone / email is set per row (enforced by the service).
-- NON-DESTRUCTIVE: a constraint is relaxed and a nullable column + index are
-- added. No row is rewritten or removed. Idempotent: every step checks
-- information_schema first. Applied by `npm run migrate` and, on every dev
-- boot, by db/ensurePasswordResetOtps.js.
-- ============================================================================

SET @nullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND COLUMN_NAME = 'phone');
SET @ddl := IF(@nullable = 'NO',
  'ALTER TABLE password_reset_otps MODIFY COLUMN phone VARCHAR(10) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND COLUMN_NAME = 'email');
SET @ddl := IF(@has = 0,
  'ALTER TABLE password_reset_otps ADD COLUMN email VARCHAR(190) NULL AFTER phone', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps' AND INDEX_NAME = 'idx_pro_email_created');
SET @ddl := IF(@has = 0,
  'ALTER TABLE password_reset_otps ADD KEY idx_pro_email_created (email, created_at)', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
