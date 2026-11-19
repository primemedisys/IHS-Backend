/**
 * Maps `blood_audit_logs` (migration 039): append-only trail of every
 * important blood-bank operation (donation, unit, test, release, reservation,
 * cross-match, issue, discard, request status ...). Written inside the same
 * transaction as the change it records. Never updated or deleted by the app.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const BloodAuditLog = sequelize.define(
  "BloodAuditLog",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    actorUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    entityType: { type: DataTypes.STRING(30), allowNull: false },
    entityId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    action: { type: DataTypes.STRING(50), allowNull: false },
    fromStatus: { type: DataTypes.STRING(30), allowNull: true },
    toStatus: { type: DataTypes.STRING(30), allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_audit_logs",
    timestamps: false,
    indexes: [
      { fields: ["blood_bank_id", "created_at"], name: "idx_bal_bank" },
      { fields: ["entity_type", "entity_id"], name: "idx_bal_entity" },
    ],
  }
);

module.exports = BloodAuditLog;
