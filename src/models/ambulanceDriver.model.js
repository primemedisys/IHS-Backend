/**
 * Maps `ambulance_drivers` (migration 040): a driver record owned by ONE
 * ambulance provider. Drivers have no login of their own (no provider module
 * has staff sub-accounts); the provider manages them and assigns them to
 * bookings.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AmbulanceDriver = sequelize.define(
  "AmbulanceDriver",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    licenseNumber: { type: DataTypes.STRING(50), allowNull: false },
    licenseValidUntil: { type: DataTypes.DATEONLY, allowNull: true },
    emergencyContactName: { type: DataTypes.STRING(150), allowNull: true },
    emergencyContactPhone: { type: DataTypes.STRING(20), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "ambulance_drivers",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["provider_id", "license_number"], name: "uq_ad_provider_license" },
      { fields: ["provider_id", "is_active"], name: "idx_ad_provider" },
    ],
  }
);

module.exports = AmbulanceDriver;
