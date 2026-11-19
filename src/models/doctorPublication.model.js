/**
 * Maps `doctor_publications` (docs/dbstruct.md §6i) — papers / research. 1:M off
 * doctor_profiles.user_id (as `doctorId`). Optional portfolio section.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorPublication = sequelize.define(
  "DoctorPublication",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(300), allowNull: false },
    authors: { type: DataTypes.STRING(500), allowNull: true }, // migration 049
    // Journal / conference name.
    publisher: { type: DataTypes.STRING(200), allowNull: true },
    year: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    url: { type: DataTypes.STRING(300), allowNull: true },
    // ── Migration 049 (all optional) ──
    doi: { type: DataTypes.STRING(150), allowNull: true },
    abstract: { type: DataTypes.STRING(2000), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_publications", timestamps: false }
);

module.exports = DoctorPublication;
