/**
 * Maps `blood_crossmatches` (migration 039): the cross-match RESULT recorded
 * by qualified staff for one unit against one request. The software never
 * infers compatibility; a `compatible` record is the safety gate before issue.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodCrossmatch = sequelize.define(
  "BloodCrossmatch",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    unitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    reservationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    result: { type: DataTypes.ENUM(...Object.values(B.CROSSMATCH_RESULT)), allowNull: false },
    method: { type: DataTypes.STRING(100), allowNull: true },
    performedAt: { type: DataTypes.DATE, allowNull: false },
    performedByName: { type: DataTypes.STRING(150), allowNull: false },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    recordedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_crossmatches",
    timestamps: true,
    indexes: [
      { fields: ["request_id"], name: "idx_bcm_request" },
      { fields: ["unit_id"], name: "idx_bcm_unit" },
      { fields: ["blood_bank_id", "performed_at"], name: "idx_bcm_bank" },
    ],
  }
);

module.exports = BloodCrossmatch;
