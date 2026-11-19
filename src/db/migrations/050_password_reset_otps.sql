-- ============================================================================
-- 050 — Password reset by mobile OTP
--
-- A patient who forgot their password can prove they own their registered
-- mobile number with a 6-digit SMS code. A verified code is exchanged for a
-- normal single-use password_reset_tokens row, so the actual password change
-- still goes through the existing POST /auth/reset-password (same hashing, same
-- "revoke every session" behaviour).
--
--   password_reset_otps — one row per code sent: HMAC of the code (never the
--                         code), the canonical 10-digit phone, attempt counter,
--                         expiry, consumed flag.
--
-- ADDITIVE ONLY: a new table; nothing existing is altered. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED  NULL,
  phone       VARCHAR(10)      NOT NULL,
  code_hash   CHAR(64)         NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME         NOT NULL,
  consumed_at DATETIME         NULL,
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pro_phone_created (phone, created_at),
  CONSTRAINT fk_pro_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
