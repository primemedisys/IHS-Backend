/**
 * Maps `patient_acquisition_sources` (migration 056) — how a patient ORIGINALLY
 * discovered a doctor. One row per (patient, doctor), written once on the first
 * booking that carries an answer and never overwritten afterwards.
 * `doctorId` is the doctor's user id (doctor_profiles.user_id).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientAcquisitionSource = sequelize.define(
  "PatientAcquisitionSource",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    sourceGroup: { type: DataTypes.STRING(30), allowNull: false },
    source: { type: DataTypes.STRING(40), allowNull: false },
    otherText: { type: DataTypes.STRING(120), allowNull: true },
    referralDetails: { type: DataTypes.STRING(160), allowNull: true },
    firstBookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    capturedVia: { type: DataTypes.STRING(20), allowNull: true },
    capturedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    utm: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "patient_acquisition_sources",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["patient_id", "doctor_id"], name: "uq_pas_patient_doctor" },
      { fields: ["doctor_id", "source_group"], name: "idx_pas_doctor_group" },
    ],
  }
);

module.exports = PatientAcquisitionSource;
