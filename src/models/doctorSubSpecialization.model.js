/**
 * Junction for the doctor ↔ sub-specialization M:N
 * (docs/bugfix-05-09-2026/doctor-specialization-sub-specialization.md).
 * Composite PK (doctorId, subSpecializationId). Used as the `through` table;
 * the app never queries it directly — it goes through the belongsToMany association.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorSubSpecialization = sequelize.define(
  "DoctorSubSpecialization",
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    subSpecializationId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  },
  { tableName: "doctor_sub_specializations", timestamps: false }
);

module.exports = DoctorSubSpecialization;
