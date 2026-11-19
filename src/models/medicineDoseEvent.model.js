/**
 * Maps `medicine_dose_events` (migration 055) — append-only audit of every
 * dose action (taken / skipped / snoozed / missed). Never updated or deleted
 * by the app; the dose row holds the current status, this holds the history.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineDoseEvent = sequelize.define(
  "MedicineDoseEvent",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doseLogId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    action: { type: DataTypes.ENUM("taken", "skipped", "snoozed", "missed"), allowNull: false },
    snoozeMinutes: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
    actedAt: { type: DataTypes.DATE, allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "medicine_dose_events", timestamps: true, updatedAt: false }
);

module.exports = MedicineDoseEvent;
