/**
 * Maps `blood_bank_profiles` (migration 039): the Blood Bank / Blood Centre
 * account's own details. PK-is-the-FK on users.id, shaped after ClinicProfile
 * (same verificationStatus trio), because a blood bank goes through the same
 * kind of admin approval queue. The centre's Google location lives on the
 * users row (address_line/city/state/pincode/lat/lng, migration 034) exactly
 * like the other providers; `district` is the one extra address part kept here.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodBankProfile = sequelize.define(
  "BloodBankProfile",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    centreName: { type: DataTypes.STRING(150), allowNull: false },
    centreType: { type: DataTypes.ENUM(...Object.values(B.BLOOD_CENTRE_TYPES)), allowNull: false, defaultValue: B.BLOOD_CENTRE_TYPES.STANDALONE },
    licenseNumber: { type: DataTypes.STRING(100), allowNull: true },
    licenseValidUntil: { type: DataTypes.DATEONLY, allowNull: true },
    contactPerson: { type: DataTypes.STRING(150), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    emergencyPhone: { type: DataTypes.STRING(20), allowNull: true },
    district: { type: DataTypes.STRING(100), allowNull: true },
    operatingHours: { type: DataTypes.STRING(150), allowNull: true },
    is24x7: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_24x7" },
    /** Component keys (config/bloodBank.js) this centre handles. */
    componentsOffered: { type: DataTypes.JSON, allowNull: true },
    about: { type: DataTypes.STRING(1000), allowNull: true },
    verificationStatus: { type: DataTypes.ENUM(...Object.values(B.BLOOD_BANK_VERIFICATION)), allowNull: false, defaultValue: B.BLOOD_BANK_VERIFICATION.PENDING },
    verificationNotes: { type: DataTypes.STRING(500), allowNull: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_bank_profiles",
    timestamps: true,
    indexes: [
      { fields: ["verification_status", "is_active"], name: "idx_bbp_verification" },
    ],
  }
);

module.exports = BloodBankProfile;
