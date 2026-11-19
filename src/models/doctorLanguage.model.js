/**
 * Junction for the doctor ↔ language M:N (docs/dbstruct.md §6e).
 * Composite PK (doctorId, languageId). Used only as a `through` table.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorLanguage = sequelize.define(
  "DoctorLanguage",
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    languageId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  },
  { tableName: "doctor_languages", timestamps: false }
);

module.exports = DoctorLanguage;
