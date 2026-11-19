/**
 * Junction for the doctor ↔ specialization M:N (docs/dbstruct.md §6d).
 * Composite PK (doctorId, specializationId). Used as the `through` table; the
 * app never queries it directly — it goes through the belongsToMany association.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorSpecialization = sequelize.define(
  "DoctorSpecialization",
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    specializationId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  },
  { tableName: "doctor_specializations", timestamps: false }
);

module.exports = DoctorSpecialization;
