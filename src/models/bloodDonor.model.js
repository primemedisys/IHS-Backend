/**
 * Maps `blood_donors` (migration 039): a donor registered BY one blood bank.
 * Donor records are that bank's private operational data (every query is
 * scoped by blood_bank_id). `patientUserId` optionally links the donor to a
 * registered IHS patient (e.g. from a camp registration).
 *
 * `status` is the RECORDED outcome of the latest screening: the software never
 * decides eligibility.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodDonor = sequelize.define(
  "BloodDonor",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donorCode: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_bd_code" },
    patientUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
    gender: { type: DataTypes.ENUM(...B.GENDER_VALUES), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: true },
    addressLine: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    bloodGroup: { type: DataTypes.ENUM(...B.BLOOD_GROUPS), allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(B.DONOR_STATUS)), allowNull: false, defaultValue: B.DONOR_STATUS.ACTIVE },
    deferredUntil: { type: DataTypes.DATEONLY, allowNull: true },
    lastDonationAt: { type: DataTypes.DATE, allowNull: true },
    donationCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    consentGiven: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    consentAt: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_donors",
    timestamps: true,
    indexes: [
      { fields: ["blood_bank_id", "status"], name: "idx_bd_bank" },
      { fields: ["blood_bank_id", "phone"], name: "idx_bd_bank_phone" },
      { fields: ["patient_user_id"], name: "idx_bd_patient" },
    ],
  }
);

module.exports = BloodDonor;
