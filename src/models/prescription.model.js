/**
 * Maps `prescriptions` (migration 006) — one per booking per version.
 *
 * `templateSnapshot` is the frozen copy of the letterhead as it looked when the
 * doctor signed. A finalized prescription ALWAYS renders from it, never from
 * the live `template_id` row: a legal medical record cannot be retroactively
 * restyled by a settings change. See docs/prescriptions/README.md §4.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Prescription = sequelize.define(
  "Prescription",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // NULL reserved for walk-ins
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    templateId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

    status: {
      type: DataTypes.ENUM("draft", "finalized"),
      allowNull: false,
      defaultValue: "draft",
    },
    rxNumber: { type: DataTypes.STRING(40), allowNull: true },
    version: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    parentPrescriptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    supersededById: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    amendReason: { type: DataTypes.STRING(255), allowNull: true },

    // ── clinical content ─────────────────────────────────────────────────────
    chiefComplaint: { type: DataTypes.STRING(500), allowNull: true },
    heightCm: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    weightKg: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    bloodPressure: { type: DataTypes.STRING(20), allowNull: true },
    pulseRateBpm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    temperatureF: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
    spo2Percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
    diagnosis: { type: DataTypes.STRING(500), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    advice: { type: DataTypes.TEXT, allowNull: true },
    adviceSelected: { type: DataTypes.JSON, allowNull: true }, // string[] ticked from the sidebar
    followUpDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Migration 051: the doctor explicitly ticked "medication not needed".
    noMedication: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Migration 059: the Patient Workbench information this prescription was
    // written from (patient, consultation, vitals, complaints, examinations,
    // diagnoses, follow-up). Refreshed while a draft; frozen at finalize.
    clinicalSnapshot: { type: DataTypes.JSON, allowNull: true },

    // ── the freeze ───────────────────────────────────────────────────────────
    templateSnapshot: { type: DataTypes.JSON, allowNull: true }, // written at finalize
    pdfUrl: { type: DataTypes.STRING(500), allowNull: true },
    finalizedAt: { type: DataTypes.DATE, allowNull: true },

    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "prescriptions" }
);

module.exports = Prescription;
