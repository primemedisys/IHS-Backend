/**
 * Maps `uploaded_records` (docs/dbstruct.md §16) — a 1:M list of past reports /
 * prescriptions the patient uploads (URL only in this phase; binary upload
 * later). `patientId` is users.id (this table FKs users, not patient_profiles).
 */
const { DataTypes, Op } = require("sequelize");
const sequelize = require("../config/database");
const { RECORD_FILE_TYPES, IDENTITY_FILE_TYPE } = require("../config/constants");

const UploadedRecord = sequelize.define(
  "UploadedRecord",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fileUrl: { type: DataTypes.STRING(500), allowNull: false },
    fileType: {
      // 'identity' added by migration 058 (Aadhaar / insurance / scheme cards).
      type: DataTypes.ENUM(...RECORD_FILE_TYPES),
      allowNull: false,
      defaultValue: "prescription",
    },
    /** The finer document type the patient picked (migration 058; constants.DOCUMENT_KINDS). */
    documentKind: { type: DataTypes.STRING(40), allowNull: true },
    recordDate: { type: DataTypes.DATEONLY, allowNull: true },
    tag: { type: DataTypes.STRING(100), allowNull: true },
    /** Where the test/scan was done (migration 022). Mirrors patient_vitals.location. */
    location: { type: DataTypes.STRING(150), allowNull: true },
    /** The doctor named on the document — may be outside IHS (migration 058). */
    doctorName: { type: DataTypes.STRING(120), allowNull: true },
    /** The patient's own notes about the document (migration 058). */
    description: { type: DataTypes.STRING(1000), allowNull: true },
    /** Last four digits of an ID / policy number ONLY — never a full Aadhaar number (migration 058). */
    idLast4: { type: DataTypes.CHAR(4), allowNull: true },
    /** What was uploaded, for display (migration 058). Null on older rows. */
    originalName: { type: DataTypes.STRING(255), allowNull: true },
    mimeType: { type: DataTypes.STRING(120), allowNull: true },
    fileSize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /**
     * Who authored this row (migration 018; 'admin' added by migration 024;
     * 'diagnostic_lab' by migration 038 — a lab's report filed on completion).
     */
    source: {
      type: DataTypes.ENUM("patient", "doctor", "clinic", "admin", "diagnostic_lab"),
      allowNull: false,
      defaultValue: "patient",
    },
    /**
     * The actual author's users.id, for the display name. ON DELETE SET NULL in
     * the schema: deleting the author's account must not delete the record.
     */
    recordedByUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    /** Last metadata edit or file replacement (migration 058). Null = never changed. */
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "uploaded_records",
    timestamps: false,
    /**
     * Identity documents (Aadhaar, insurance cards …) are the patient's alone.
     * `UploadedRecord.scope("clinical")` = every document EXCEPT those — what
     * clinic / admin lists read. Deliberately NOT a defaultScope: Sequelize
     * turns a scoped include into an INNER JOIN, which would hide a patient
     * with no documents from booking / profile lookups. Doctor reads are
     * guarded in clinicalAccess.recordAllowed / by explicit category filters.
     */
    scopes: { clinical: { where: { fileType: { [Op.ne]: IDENTITY_FILE_TYPE } } } },
  }
);

module.exports = UploadedRecord;
