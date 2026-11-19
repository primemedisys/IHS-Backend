/**
 * Maps `refresh_tokens` (docs/auth/README.md §4). One row per active or
 * rotated session. We store only the SHA-256 hash of the raw token, plus the
 * user-agent / IP for auditing. `revokedAt != null` means the token was rotated
 * or logged out; presenting a revoked token again is treated as theft.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const RefreshToken = sequelize.define(
  "RefreshToken",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "refresh_tokens" }
);

module.exports = RefreshToken;
