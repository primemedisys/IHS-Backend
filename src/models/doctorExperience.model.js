/**
 * Maps `doctor_experience` (docs/dbstruct.md §6g) — a doctor's career timeline
 * (hospitals / positions held). 1:M off doctor_profiles.user_id (as `doctorId`).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorExperience = sequelize.define(
  "DoctorExperience",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    organization: { type: DataTypes.STRING(200), allowNull: false },
    roleTitle: { type: DataTypes.STRING(150), allowNull: false },
    // City / address of the role (migration 049, optional).
    location: { type: DataTypes.STRING(150), allowNull: true },
    startYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    endYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_experience", timestamps: false }
);

module.exports = DoctorExperience;
