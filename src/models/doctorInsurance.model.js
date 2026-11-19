/**
 * Maps `doctor_insurances` (docs/dbstruct.md §6m) — the M:N junction between a
 * doctor and the insurance providers they accept. Composite PK, no timestamps.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorInsurance = sequelize.define(
  "DoctorInsurance",
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    insuranceId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  },
  { tableName: "doctor_insurances", timestamps: false }
);

module.exports = DoctorInsurance;
