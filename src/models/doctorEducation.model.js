/**
 * Maps `doctor_education` (docs/dbstruct.md §6f) — a doctor's structured
 * qualifications/schooling timeline. 1:M off doctor_profiles.user_id (as
 * `doctorId`). `underscored: true` maps camelCase attrs → snake_case columns.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorEducation = sequelize.define(
  "DoctorEducation",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    degree: { type: DataTypes.STRING(150), allowNull: false },
    institution: { type: DataTypes.STRING(200), allowNull: false },
    fieldOfStudy: { type: DataTypes.STRING(150), allowNull: true },
    // Where the institution is (migration 049, optional).
    location: { type: DataTypes.STRING(150), allowNull: true },
    yearFrom: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    yearTo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_education", timestamps: false }
);

module.exports = DoctorEducation;
