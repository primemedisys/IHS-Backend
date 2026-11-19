/**
 * Maps `doctor_awards` (docs/dbstruct.md §6b) — a doctor's portfolio
 * achievements. 1:M off doctor_profiles.user_id (as `doctorId`).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorAward = sequelize.define(
  "DoctorAward",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    // Issuing organisation (migration 048, optional).
    issuer: { type: DataTypes.STRING(255), allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    awardYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    // Optional uploaded award / certificate picture (migration 048).
    imageUrl: { type: DataTypes.STRING(512), allowNull: true },
  },
  { tableName: "doctor_awards", timestamps: false }
);

module.exports = DoctorAward;
