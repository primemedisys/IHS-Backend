/**
 * Maps `blood_tests` (migration 039): one laboratory screening result on a
 * donation's sample (it applies to every unit made from that donation), as
 * entered by the person who performed it. Recorded, never interpreted.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodTest = sequelize.define(
  "BloodTest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    testName: { type: DataTypes.STRING(100), allowNull: false },
    result: { type: DataTypes.ENUM(...Object.values(B.TEST_RESULT)), allowNull: false },
    resultValue: { type: DataTypes.STRING(100), allowNull: true },
    method: { type: DataTypes.STRING(100), allowNull: true },
    testedAt: { type: DataTypes.DATE, allowNull: false },
    performedByName: { type: DataTypes.STRING(150), allowNull: false },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    recordedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_tests",
    timestamps: true,
    indexes: [
      { fields: ["donation_id"], name: "idx_bt_donation" },
      { fields: ["blood_bank_id", "tested_at"], name: "idx_bt_bank" },
    ],
  }
);

module.exports = BloodTest;
