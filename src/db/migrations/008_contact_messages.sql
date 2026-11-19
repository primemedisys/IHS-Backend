-- ============================================================================
-- 008 — Contact messages (public "Contact us" form)
--
-- Stores submissions from the public contact form (frontend-patient /contact).
-- No auth and no FK: a visitor need not have an account. `handled` lets the
-- admin inbox mark a message as followed-up. Idempotent (IF NOT EXISTS) — safe
-- to re-run alongside the dev-time sequelize.sync().
--
-- NO `USE <db>` here on purpose: the migration runner already selects the
-- configured database (env.DB_NAME).
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_messages (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    email       VARCHAR(255) NOT NULL,
    phone       VARCHAR(30)  NULL,
    message     TEXT NOT NULL,
    ip_address  VARCHAR(45)  NULL,               -- spam triage only
    handled     TINYINT(1) NOT NULL DEFAULT 0,   -- admin inbox: followed-up?
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_contact_created (created_at),
    INDEX idx_contact_handled (handled)
) ENGINE=InnoDB;
