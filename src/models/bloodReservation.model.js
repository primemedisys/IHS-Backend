/**
 * Maps `blood_reservations` (migration 039): one unit held for one request.
 * active -> issued, or active -> released (the unit goes back to available).
 * Created only under a row lock on the unit, so a unit can never be reserved
 * twice.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodReservation = sequelize.define(
  "BloodReservation",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    unitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(B.RESERVATION_STATUS)), allowNull: false, defaultValue: B.RESERVATION_STATUS.ACTIVE },
    reservedByName: { type: DataTypes.STRING(150), allowNull: false },
    reservedAt: { type: DataTypes.DATE, allowNull: false },
    releasedAt: { type: DataTypes.DATE, allowNull: true },
    releaseReason: { type: DataTypes.STRING(255), allowNull: true },
    recordedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_reservations",
    timestamps: true,
    indexes: [
      { fields: ["request_id", "status"], name: "idx_brs_request" },
      { fields: ["unit_id", "status"], name: "idx_brs_unit" },
      { fields: ["blood_bank_id", "status"], name: "idx_brs_bank" },
    ],
  }
);

module.exports = BloodReservation;
