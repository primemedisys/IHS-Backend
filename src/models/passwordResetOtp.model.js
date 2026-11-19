/**
 * Maps `password_reset_otps` (migration 050) — the "forgot password by mobile"
 * one-time codes. Only an HMAC of the code is stored (bound to the phone), never
 * the code itself.
 *
 * Codes go by SMS (`phone`) or, since migration 052, by email (`email`).
 *
 * `userId` is NULL when the number belongs to more than one patient account:
 * the OTP still proves the patient owns the phone, but there is no single
 * account to reset, so verification tells them to use the email reset instead.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PasswordResetOtp = sequelize.define(
  "PasswordResetOtp",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    // Exactly one of phone / email: the channel the code was sent on (migration 052 added email).
    phone: { type: DataTypes.STRING(10), allowNull: true },
    email: { type: DataTypes.STRING(190), allowNull: true },
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "password_reset_otps", updatedAt: false }
);

module.exports = PasswordResetOtp;
