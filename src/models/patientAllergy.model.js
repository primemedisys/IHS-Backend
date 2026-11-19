/**
 * Junction for the patient ↔ allergy M:N (docs/dbstruct.md §2a). Composite PK
 * (patientId, allergyId); `severity` is specific to this patient's entry. Used
 * as the `through` table — the app goes through the belongsToMany association.
 * `patientId` is patient_profiles.user_id (== users.id for that patient).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientAllergy = sequelize.define(
  "PatientAllergy",
  {
    patientId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    allergyId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    severity: { type: DataTypes.ENUM("mild", "moderate", "severe"), allowNull: true },
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
  { tableName: "patient_allergies", timestamps: false }
);

module.exports = PatientAllergy;
