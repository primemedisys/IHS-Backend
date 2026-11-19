/**
 * Maps `patient_medicine_settings` (migration 055) — one row per patient,
 * created lazily on first read. `privacyMode` hides medicine names from
 * reminder text (lock screens, browser pop-ups).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientMedicineSettings = sequelize.define(
  "PatientMedicineSettings",
  {
    patientId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    privacyMode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    webReminders: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    defaultSnoozeMinutes: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 10 },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Asia/Kolkata" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "patient_medicine_settings", timestamps: true }
);

module.exports = PatientMedicineSettings;
