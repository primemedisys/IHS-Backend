/**
 * Maps `patient_vitals` (migration 010) — the patient's self-recorded, DATED
 * vitals timeline that powers the "record table" (docs/patient-health-records).
 * One row per (patient, recordedOn); the same six fields/types as
 * `clinical_notes` vitals so patient- and doctor-recorded readings are
 * interchangeable. `source` marks who logged it; BMI is DERIVED in the
 * serializer, never stored. `patientId` is patient_profiles.user_id.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientVitals = sequelize.define(
  "PatientVitals",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    recordedOn: { type: DataTypes.DATEONLY, allowNull: false },
    // Migration 051: the exact time of the reading and the visit it was taken
    // in. NULL on every pre-existing row (those only ever had a date).
    recordedAt: { type: DataTypes.DATE, allowNull: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

    bloodPressure: { type: DataTypes.STRING(20), allowNull: true },
    bpSystolic: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    bpDiastolic: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    pulseRateBpm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    heartRateBpm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    respiratoryRate: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    weightKg: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    heightCm: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    waistCm: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    hipCm: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    headCircumferenceCm: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    temperatureF: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
    spo2Percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },

    note: { type: DataTypes.STRING(255), allowNull: true },
    location: { type: DataTypes.STRING(150), allowNull: true }, // free-text place the reading was taken
    /** Who authored this row (migration 018). */
    source: {
      type: DataTypes.ENUM("patient", "doctor", "clinic"),
      allowNull: false,
      defaultValue: "patient",
    },
    /**
     * The actual author's users.id, for the display name. ON DELETE SET NULL in
     * the schema: deleting the author's account must not delete the record.
     */
    recordedByUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "patient_vitals", timestamps: false }
);

module.exports = PatientVitals;
