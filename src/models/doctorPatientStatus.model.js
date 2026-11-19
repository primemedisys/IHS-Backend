/**
 * A doctor's MANUAL status override for one of their patients (migration 023).
 *
 * Composite PK — one status per doctor↔patient pair. Rows exist only where the
 * doctor overrode the derived value; "new patient" / "OPD follow-up" are
 * computed from visit count at read time and never stored, so this table only
 * grows when a doctor actively re-categorises someone.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorPatientStatus = sequelize.define(
  "DoctorPatientStatus",
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    status: {
      type: DataTypes.ENUM("new_patient", "opd_followup", "surgery_pending", "surgery_followup"),
      allowNull: false,
    },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "doctor_patient_statuses", timestamps: false }
);

module.exports = DoctorPatientStatus;
