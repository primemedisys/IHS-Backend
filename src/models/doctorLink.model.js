/**
 * Maps `doctor_links` (docs/dbstruct.md §6c) — a doctor's social/web links.
 * 1:M off doctor_profiles.user_id (as `doctorId`).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { LINK_TYPES } = require("../config/constants");

const DoctorLink = sequelize.define(
  "DoctorLink",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    linkType: { type: DataTypes.ENUM(...Object.values(LINK_TYPES)), allowNull: false },
    url: { type: DataTypes.STRING(300), allowNull: false },
  },
  { tableName: "doctor_links", timestamps: false }
);

module.exports = DoctorLink;
