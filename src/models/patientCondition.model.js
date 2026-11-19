/**
 * Junction for the patient ↔ condition M:N (docs/dbstruct.md §2b). Composite PK
 * (patientId, conditionId); `diagnosedYear` is specific to this patient's entry.
 * `patientId` is patient_profiles.user_id (== users.id for that patient).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientCondition = sequelize.define(
  "PatientCondition",
  {
    patientId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    conditionId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    diagnosedYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
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
  },
  { tableName: "patient_conditions", timestamps: false }
);

module.exports = PatientCondition;
