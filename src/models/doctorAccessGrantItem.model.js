/**
 * Maps `doctor_access_grant_items` (migration 045) — ONE uploaded record the
 * patient chose to share under an approved DoctorAccessRequest.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorAccessGrantItem = sequelize.define(
  "DoctorAccessGrantItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    recordId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "doctor_access_grant_items", timestamps: false }
);

module.exports = DoctorAccessGrantItem;
