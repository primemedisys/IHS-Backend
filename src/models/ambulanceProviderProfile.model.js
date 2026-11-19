/**
 * Maps `ambulance_provider_profiles` (migration 040): the ambulance operator
 * organisation behind an `ambulance_provider` account. PK-is-the-FK on
 * users.id, shaped after BloodBankProfile (same verification trio + is_active
 * suspension). The provider's address / Google location lives on the users row
 * (address_line/city/state/pincode/lat/lng, migration 034) like every provider.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const A = require("../config/ambulance");

const AmbulanceProviderProfile = sequelize.define(
  "AmbulanceProviderProfile",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    organizationName: { type: DataTypes.STRING(150), allowNull: false },
    contactPerson: { type: DataTypes.STRING(150), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    emergencyPhone: { type: DataTypes.STRING(20), allowNull: true },
    district: { type: DataTypes.STRING(100), allowNull: true },
    is24x7: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_24x7" },
    about: { type: DataTypes.STRING(1000), allowNull: true },
    verificationStatus: {
      type: DataTypes.ENUM(...Object.values(A.AMBULANCE_VERIFICATION)),
      allowNull: false,
      defaultValue: A.AMBULANCE_VERIFICATION.PENDING,
    },
    verificationNotes: { type: DataTypes.STRING(500), allowNull: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "ambulance_provider_profiles",
    timestamps: true,
    indexes: [{ fields: ["verification_status", "is_active"], name: "idx_app_verification" }],
  }
);

module.exports = AmbulanceProviderProfile;
