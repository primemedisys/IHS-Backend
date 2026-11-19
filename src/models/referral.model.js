/**
 * Maps `referrals` (migration 011) — a directed edge inside a care journey:
 * Dr A ──(reason)──▶ Dr B. Created by A from A's booking; "booked" once the
 * patient books B, which stamps `targetBookingId` and shares `journeyId`.
 *
 * Both doctor FKs are doctor_profiles.user_id (== users.id for that doctor);
 * `patientId` is users.id (denormalized so the patient inbox query is one index
 * hit). The global `underscored: true` maps fromDoctorId → from_doctor_id, etc.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Referral = sequelize.define(
  "Referral",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    journeyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fromDoctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    toDoctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    sourceBookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    targetBookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    note: { type: DataTypes.STRING(1000), allowNull: true },
    status: {
      type: DataTypes.ENUM("pending", "booked", "completed", "cancelled", "declined"),
      allowNull: false,
      defaultValue: "pending",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "referrals", timestamps: true }
);

module.exports = Referral;
