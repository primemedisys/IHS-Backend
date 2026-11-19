/**
 * Maps `clinical_notes` (migration 009) — a patient-wide, append-only clinical
 * log a doctor writes from an appointment (PRD: doctor consultation records).
 *
 * `doctorId` is the AUTHORING doctor (doctor_profiles.user_id); `patientId` is
 * the patient (users.id); `bookingId` is the appointment it was written from
 * (nullable so a note survives a deleted booking). The global `underscored: true`
 * maps camelCase attributes to the snake_case columns (onExamination →
 * on_examination, etc.).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ClinicalNote = sequelize.define(
  "ClinicalNote",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    // NULLABLE since migration 018: a clinic-authored note has no doctor, and
    // this column FKs doctor_profiles(user_id), which a clinic's id would fail.
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

    complaints: { type: DataTypes.TEXT, allowNull: true }, // c/o
    onExamination: { type: DataTypes.TEXT, allowNull: true }, // o/e
    historyMedical: { type: DataTypes.TEXT, allowNull: true }, // h/o medical
    historySurgical: { type: DataTypes.TEXT, allowNull: true }, // h/o surgical
    diagnosis: { type: DataTypes.TEXT, allowNull: true },
    treatment: { type: DataTypes.TEXT, allowNull: true },

    // ── vitals (same shape/types as the prescription's Vitals) ─────────────────
    bloodPressure: { type: DataTypes.STRING(20), allowNull: true },
    pulseRateBpm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    weightKg: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    heightCm: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    temperatureF: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
    spo2Percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },

    /** Who authored this row (migration 018). */
    source: {
      type: DataTypes.ENUM("patient", "doctor", "clinic"),
      allowNull: false,
      defaultValue: "doctor",
    },
    /**
     * The actual author's users.id, for the display name. ON DELETE SET NULL in
     * the schema: deleting the author's account must not delete the record.
     */
    recordedByUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "clinical_notes", timestamps: false }
);

module.exports = ClinicalNote;
