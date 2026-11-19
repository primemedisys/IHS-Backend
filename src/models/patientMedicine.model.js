/**
 * Maps `patient_medicines` (migration 055) — ONE patient's routine for ONE
 * medicine. Either copied from a finalized prescription line
 * (`source: prescription`, `prescriptionItemId` UNIQUE so a re-run never
 * duplicates it) or entered by the patient (`source: patient`, never verified
 * as a prescription).
 *
 * The medicine fields are a snapshot (name / strength / form at the time), so
 * a later catalogue edit never rewrites what the patient was told to take.
 * `prescribedSnapshot` keeps the doctor's original line untouched; the patient
 * may change only their own reminder preferences on a prescribed routine.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientMedicine = sequelize.define(
  "PatientMedicine",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    source: { type: DataTypes.ENUM("prescription", "patient"), allowNull: false },
    prescriptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    prescriptionItemId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    prescribedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineName: { type: DataTypes.STRING(200), allowNull: false },
    genericName: { type: DataTypes.STRING(255), allowNull: true },
    strength: { type: DataTypes.STRING(100), allowNull: true },
    dosageForm: { type: DataTypes.STRING(50), allowNull: true },
    dose: { type: DataTypes.STRING(100), allowNull: true },
    frequency: { type: DataTypes.STRING(100), allowNull: true },
    foodTiming: { type: DataTypes.ENUM("before_food", "after_food", "with_food", "anytime"), allowNull: true },
    /** ["08:00","20:00"] — local wall-clock times in `timezone`. */
    reminderTimes: { type: DataTypes.JSON, allowNull: true },
    /** null = every day; else weekday numbers 0 (Sun) … 6 (Sat). */
    daysOfWeek: { type: DataTypes.JSON, allowNull: true },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Asia/Kolkata" },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    durationDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    instructions: { type: DataTypes.STRING(500), allowNull: true },
    prescribedSnapshot: { type: DataTypes.JSON, allowNull: true },
    reminderEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
      type: DataTypes.ENUM("active", "paused", "completed", "cancelled"),
      allowNull: false,
      defaultValue: "active",
    },
    statusReason: { type: DataTypes.STRING(50), allowNull: true },
    statusChangedAt: { type: DataTypes.DATE, allowNull: true },
    supersededById: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    clientRequestId: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "patient_medicines",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["prescription_item_id"], name: "uq_pm_rx_item" },
      { unique: true, fields: ["patient_id", "client_request_id"], name: "uq_pm_client_request" },
      { fields: ["patient_id", "status"], name: "idx_pm_patient_status" },
      { fields: ["prescription_id"], name: "idx_pm_prescription" },
    ],
  }
);

module.exports = PatientMedicine;
