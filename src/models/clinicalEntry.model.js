const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { CLINICAL_ENTRY_KINDS, CLINICAL_ENTRY_STATUS } = require("../config/constants");

/**
 * One structured consultation entry (migration 051): a chief complaint, a
 * history entry, a comorbidity, an examination form, a diagnosis, an
 * investigation order or a doctor's note. Linked to the patient, the authoring
 * doctor and — when written during a consultation — the booking (the visit).
 *
 * Never hard-deleted. A wrong entry is retired (status entered_in_error + a
 * reason) so the clinical history stays intact.
 */
const ClinicalEntry = sequelize.define(
  "ClinicalEntry",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    kind: { type: DataTypes.ENUM(...CLINICAL_ENTRY_KINDS), allowNull: false },
    category: { type: DataTypes.STRING(60), allowNull: true },
    title: { type: DataTypes.STRING(255), allowNull: true },
    code: { type: DataTypes.STRING(20), allowNull: true },
    // Migration 059 — the ICD catalogue row a diagnosis was picked from, and a
    // snapshot of what was picked (stays accurate if the catalogue changes).
    icdCodeId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    codeSystem: { type: DataTypes.STRING(20), allowNull: true },
    codeVersion: { type: DataTypes.STRING(30), allowNull: true },
    codeDescription: { type: DataTypes.STRING(1000), allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    remarks: { type: DataTypes.TEXT, allowNull: true },
    recordedOn: { type: DataTypes.DATEONLY, allowNull: true },
    patientVisible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    status: {
      type: DataTypes.ENUM(...Object.values(CLINICAL_ENTRY_STATUS)),
      allowNull: false,
      defaultValue: CLINICAL_ENTRY_STATUS.ACTIVE,
    },
    retiredReason: { type: DataTypes.STRING(255), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    updatedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "clinical_entries", timestamps: true }
);

module.exports = ClinicalEntry;
