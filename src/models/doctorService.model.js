/**
 * Maps `doctor_services` (docs/dbstruct.md §6h) — procedures / treatments a
 * doctor offers. 1:M off doctor_profiles.user_id (as `doctorId`).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorService = sequelize.define(
  "DoctorService",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_services", timestamps: false }
);

module.exports = DoctorService;
