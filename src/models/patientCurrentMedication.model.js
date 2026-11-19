/**
 * Maps `patient_current_medications` (docs/dbstruct.md §2c) — a 1:M list of the
 * meds a patient is currently taking. Not a lookup+junction: dosage/frequency/
 * notes are specific to the patient's entry, not a reusable attribute.
 * `patientId` is patient_profiles.user_id. The global `underscored:true` maps
 * camelCase attrs to snake_case columns (medicineName → medicine_name).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientCurrentMedication = sequelize.define(
  "PatientCurrentMedication",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    medicineName: { type: DataTypes.STRING(200), allowNull: false },
    dosage: { type: DataTypes.STRING(100), allowNull: true },
    frequency: { type: DataTypes.STRING(100), allowNull: true },
    startedOn: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.STRING(255), allowNull: true },
  },
  { tableName: "patient_current_medications", timestamps: false }
);

module.exports = PatientCurrentMedication;
