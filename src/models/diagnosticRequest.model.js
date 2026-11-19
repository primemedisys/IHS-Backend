/**
 * Maps `diagnostic_requests` (migration 038) — a patient shares a prescription
 * with ONE Diagnostic Lab Center (one row per lab, like prescription_requests
 * is one row per pharmacy).
 *
 * The whole diagnostic workflow lives on this row:
 *   pending → viewed → available (lab answered tests + prices)
 *     → booking_requested (patient picked tests + date) → confirmed
 *     → test_completed → report_ready,   or → rejected.
 *
 * The booking is a patient's preferred date on the row itself (one request has
 * at most one booking), with the chosen tests flagged on
 * diagnostic_request_tests.is_selected — no separate booking table.
 * The per-step timestamps let the admin track the workflow end to end.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { DIAGNOSTIC_REQUEST_STATUS } = require("../config/constants");

const DiagnosticRequest = sequelize.define(
  "DiagnosticRequest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    labId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fileUrl: { type: DataTypes.STRING(512), allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(DIAGNOSTIC_REQUEST_STATUS)),
      allowNull: false,
      defaultValue: DIAGNOSTIC_REQUEST_STATUS.PENDING,
    },
    /** The lab's message to the patient (response note or rejection reason). */
    labNote: { type: DataTypes.STRING(500), allowNull: true },
    preferredDate: { type: DataTypes.DATEONLY, allowNull: true },
    bookingNotes: { type: DataTypes.STRING(500), allowNull: true },
    respondedAt: { type: DataTypes.DATE, allowNull: true },
    bookingRequestedAt: { type: DataTypes.DATE, allowNull: true },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    reportReadyAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "diagnostic_requests",
    timestamps: true,
    indexes: [
      { fields: ["patient_id"], name: "idx_dr_patient" },
      { fields: ["lab_id"], name: "idx_dr_lab" },
      { fields: ["status"], name: "idx_dr_status" },
    ],
  }
);

module.exports = DiagnosticRequest;
