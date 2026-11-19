/**
 * Maps `clinics` (docs/dbstruct.md §8) — a doctor's physical clinic locations
 * (PRD §4.3a: one doctor -> many clinics). 1:M off doctor_profiles.user_id
 * (as `doctorId`). `lat`/`lng` come from the optional Google Maps picker or
 * manual entry; both are NULL for an address typed without a pin (migration 047).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Clinic = sequelize.define(
  "Clinic",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    addressLine: { type: DataTypes.STRING(255), allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    offlineFee: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "clinics", timestamps: false }
);

module.exports = Clinic;
