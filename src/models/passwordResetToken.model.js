/**
 * Maps `password_reset_tokens` (docs/auth/README.md §4). Single-use,
 * short-lived. Raw token lives only inside the email link; the DB keeps its
 * SHA-256 hash. `usedAt != null` means the token was already consumed.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PasswordResetToken = sequelize.define(
  "PasswordResetToken",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "password_reset_tokens" }
);

module.exports = PasswordResetToken;
