-- ============================================================================
-- Auth tables (companion to docs/dbstruct.md). Run this against clinic_platform
-- in any environment where you are NOT letting Sequelize sync() create tables
-- (i.e. staging/production). Matches docs/auth/README.md §4.
-- (No `USE <db>` here: the migration runner already selects env.DB_NAME.)
-- ============================================================================

-- ── Refresh tokens: one row per active/rotated session ───────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    user_agent  VARCHAR(255) NULL,
    ip_address  VARCHAR(45)  NULL,
    expires_at  DATETIME NOT NULL,
    revoked_at  DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_refresh_token_hash (token_hash),
    KEY idx_refresh_user (user_id),
    KEY idx_refresh_expiry (expires_at)
) ENGINE=InnoDB;

-- ── Password reset tokens: single-use, short-lived ───────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_reset_token_hash (token_hash),
    KEY idx_reset_user (user_id)
) ENGINE=InnoDB;
