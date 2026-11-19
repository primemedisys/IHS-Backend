/**
 * Maps `medicine_dose_logs` (migration 055) — one scheduled dose of one
 * patient routine. Generated for a rolling window ahead (never unbounded) and
 * UNIQUE on (routine, scheduled_at), so regeneration can never duplicate a
 * dose. `scheduledAt` / `dueAt` are UTC; `dueAt` moves forward on a snooze
 * while `scheduledAt` keeps the original slot.
 *
 * A notification being delivered never changes `status`: only the patient's
 * own Taken / Skip / Snooze does (or the missed sweep, after the grace period).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineDoseLog = sequelize.define(
  "MedicineDoseLog",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientMedicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    scheduledDate: { type: DataTypes.DATEONLY, allowNull: false },
    scheduledTime: { type: DataTypes.STRING(5), allowNull: false },
    scheduledAt: { type: DataTypes.DATE, allowNull: false },
    dueAt: { type: DataTypes.DATE, allowNull: false },
    status: {
      type: DataTypes.ENUM("pending", "taken", "skipped", "snoozed", "missed"),
      allowNull: false,
      defaultValue: "pending",
    },
    snoozeCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    actionAt: { type: DataTypes.DATE, allowNull: true },
    actionSource: { type: DataTypes.STRING(20), allowNull: true },
    notifiedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_dose_logs",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["patient_medicine_id", "scheduled_at"], name: "uq_dose_slot" },
      { fields: ["patient_id", "scheduled_at"], name: "idx_dose_patient_sched" },
      { fields: ["status", "due_at"], name: "idx_dose_status_due" },
    ],
  }
);

module.exports = MedicineDoseLog;
