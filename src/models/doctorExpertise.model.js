/**
 * Maps `doctor_expertise` (migration 049) — one row per clinical expertise,
 * scientific expertise, area of expertise or professional interest the doctor
 * lists. 1:M off doctor_profiles.user_id (as `doctorId`). Procedures are not
 * stored here: they reuse `doctor_services`. (doctorId, category, name) is
 * unique, case-insensitively.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { EXPERTISE_CATEGORIES } = require("../config/constants");

const DoctorExpertise = sequelize.define(
  "DoctorExpertise",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    category: { type: DataTypes.ENUM(...Object.values(EXPERTISE_CATEGORIES)), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.STRING(300), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_expertise", timestamps: false }
);

module.exports = DoctorExpertise;
