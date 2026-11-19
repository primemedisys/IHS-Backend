/**
 * Maps `doctor_search_keywords` (docs/dbstruct.md §18b) — the per-doctor search
 * add-on layer (PRD §4.2). A doctor tags themselves for symptoms beyond what
 * their specialization implies. `isApproved` lets an admin moderate tags.
 * UNIQUE (doctorId, keyword). 1:M off doctor_profiles.user_id.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorSearchKeyword = sequelize.define(
  "DoctorSearchKeyword",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    keyword: { type: DataTypes.STRING(150), allowNull: false },
    weight: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    isApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "doctor_search_keywords", timestamps: false }
);

module.exports = DoctorSearchKeyword;
