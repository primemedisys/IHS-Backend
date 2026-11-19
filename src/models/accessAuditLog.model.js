/**
 * Maps `access_audit_logs` (migration 045) — APPEND-ONLY trail of sensitive
 * access: doctor patient searches, consent requests and decisions, revocations,
 * expiries and record downloads. Never updated or deleted by the application.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AccessAuditLog = sequelize.define(
  "AccessAuditLog",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    actorUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    actorRole: { type: DataTypes.STRING(30), allowNull: true },
    action: { type: DataTypes.STRING(50), allowNull: false },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    entityType: { type: DataTypes.STRING(50), allowNull: true },
    entityId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "access_audit_logs", timestamps: false }
);

module.exports = AccessAuditLog;
