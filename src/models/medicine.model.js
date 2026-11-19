/**
 * Doctor medicine master-list. Each row is one medicine a doctor has prescribed
 * or may prescribe. Scoped to the owning doctor via `doctorId`.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Medicine = sequelize.define(
  "Medicine",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /** The shared catalogue row this entry is linked to (migration 055). */
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    genericName: { type: DataTypes.STRING(255), allowNull: true },
    manufacturer: { type: DataTypes.STRING(255), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    form: { type: DataTypes.STRING(50), allowNull: false, defaultValue: "oral" },
    strength: { type: DataTypes.STRING(100), allowNull: true },
    /** Tablet / capsule / syrup / … — the catalogue's MEDICINE_TYPES (migration 053). */
    dosageForm: { type: DataTypes.STRING(50), allowNull: true },
    // Migration 054 — the doctor's DEFAULT instructions, copied onto a
    // prescription line when picked and editable there. Never a duration.
    defaultFrequency: { type: DataTypes.STRING(100), allowNull: true },
    defaultTiming: { type: DataTypes.STRING(20), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "medicines", timestamps: true }
);

module.exports = Medicine;
