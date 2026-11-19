/**
 * Maps `doctor_fellowships` (migration 049) — fellowships and advanced
 * training, kept apart from formal education (`doctor_education`). 1:M off
 * doctor_profiles.user_id (as `doctorId`). `endYear` is the completion year.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorFellowship = sequelize.define(
  "DoctorFellowship",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    institution: { type: DataTypes.STRING(200), allowNull: false },
    specialtyArea: { type: DataTypes.STRING(150), allowNull: true },
    location: { type: DataTypes.STRING(150), allowNull: true },
    startYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    endYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    description: { type: DataTypes.STRING(1000), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_fellowships", timestamps: false }
);

module.exports = DoctorFellowship;
