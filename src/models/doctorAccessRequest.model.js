/**
 * Maps `doctor_access_requests` (migration 045) — a doctor's request to see
 * ONE category of a patient's uploaded records, and the patient's decision.
 * The documents actually shared are the DoctorAccessGrantItem rows the PATIENT
 * picked on approval; the category alone never grants anything.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  ACCESS_CATEGORIES,
  ACCESS_REQUEST_STATUS,
} = require("../config/constants");

const DoctorAccessRequest = sequelize.define(
  "DoctorAccessRequest",
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    category: { type: DataTypes.ENUM(...ACCESS_CATEGORIES), allowNull: false },
    purpose: { type: DataTypes.STRING(500), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(ACCESS_REQUEST_STATUS)),
      allowNull: false,
      defaultValue: ACCESS_REQUEST_STATUS.PENDING,
    },
    requestExpiresAt: { type: DataTypes.DATE, allowNull: false },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNote: { type: DataTypes.STRING(500), allowNull: true },
    grantExpiresAt: { type: DataTypes.DATE, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  { tableName: "doctor_access_requests", timestamps: true },
);

module.exports = DoctorAccessRequest;
