/**
 * Maps `blood_donations` (migration 039): one collection from one donor,
 * always tied to the ELIGIBLE screening that preceded it (one donation per
 * screening). `testingStatus` is the lab outcome as DECIDED and recorded by
 * authorised staff after the individual blood_tests results are entered.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodDonation = sequelize.define(
  "BloodDonation",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    donationCode: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_bdn_code" },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    screeningId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: "uq_bdn_screening" },
    campId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    collectedAt: { type: DataTypes.DATE, allowNull: false },
    volumeMl: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    bagType: { type: DataTypes.STRING(50), allowNull: true },
    collectedByName: { type: DataTypes.STRING(150), allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(B.DONATION_STATUS)), allowNull: false, defaultValue: B.DONATION_STATUS.COLLECTED },
    testingStatus: { type: DataTypes.ENUM(...Object.values(B.TESTING_STATUS)), allowNull: false, defaultValue: B.TESTING_STATUS.PENDING },
    testingDecidedByName: { type: DataTypes.STRING(150), allowNull: true },
    testingDecidedAt: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_donations",
    timestamps: true,
    indexes: [
      { fields: ["blood_bank_id", "collected_at"], name: "idx_bdn_bank" },
      { fields: ["donor_id"], name: "idx_bdn_donor" },
    ],
  }
);

module.exports = BloodDonation;
