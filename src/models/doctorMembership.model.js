/**
 * Maps `doctor_memberships` (docs/dbstruct.md §6j) — medical bodies /
 * associations a doctor belongs to. 1:M off doctor_profiles.user_id.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorMembership = sequelize.define(
  "DoctorMembership",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    organization: { type: DataTypes.STRING(200), allowNull: false },
    roleTitle: { type: DataTypes.STRING(150), allowNull: true },
    // ── Migration 049 (all optional) ──────────────────────────────────────────
    // The membership / registration number is PRIVATE unless the doctor turns
    // `showMembershipNumber` on — the public serializer omits it otherwise.
    membershipNumber: { type: DataTypes.STRING(100), allowNull: true },
    showMembershipNumber: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sinceYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    validUntilYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_memberships", timestamps: false }
);

module.exports = DoctorMembership;
