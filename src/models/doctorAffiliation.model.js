/**
 * Maps `doctor_affiliations` (migration 049) — the hospitals, clinics or
 * institutions a doctor currently practises at. 1:M off
 * doctor_profiles.user_id (as `doctorId`). `isCurrent` is set by the doctor —
 * nothing is ever classified "current" automatically.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorAffiliation = sequelize.define(
  "DoctorAffiliation",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    organization: { type: DataTypes.STRING(200), allowNull: false },
    roleTitle: { type: DataTypes.STRING(150), allowNull: true },
    department: { type: DataTypes.STRING(150), allowNull: true },
    location: { type: DataTypes.STRING(255), allowNull: true },
    startYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    endYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    website: { type: DataTypes.STRING(300), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_affiliations", timestamps: false }
);

module.exports = DoctorAffiliation;
