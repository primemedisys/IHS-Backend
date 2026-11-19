/**
 * Maps `blood_donor_screenings` (migration 039): a pre-donation screening
 * RECORD. The vitals are what staff measured; `decision` (eligible / deferred)
 * is what the authorised person decided. Nothing here is computed. A deferral
 * is simply a screening whose decision is deferred (+ reason / until date).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodDonorScreening = sequelize.define(
  "BloodDonorScreening",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    screenedAt: { type: DataTypes.DATE, allowNull: false },
    weightKg: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    hemoglobinGdl: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
    bpSystolic: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    bpDiastolic: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    pulseBpm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    temperatureC: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
    questionnaireCleared: { type: DataTypes.BOOLEAN, allowNull: true },
    decision: { type: DataTypes.ENUM(...Object.values(B.SCREENING_DECISION)), allowNull: false },
    deferralReason: { type: DataTypes.STRING(255), allowNull: true },
    deferredUntil: { type: DataTypes.DATEONLY, allowNull: true },
    screenedByName: { type: DataTypes.STRING(150), allowNull: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    recordedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_donor_screenings",
    timestamps: true,
    indexes: [
      { fields: ["donor_id", "screened_at"], name: "idx_bds_donor" },
      { fields: ["blood_bank_id"], name: "idx_bds_bank" },
    ],
  }
);

module.exports = BloodDonorScreening;
