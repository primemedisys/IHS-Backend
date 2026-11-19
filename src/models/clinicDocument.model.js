/**
 * Maps `clinic_documents` (migration 017) — verification paperwork for a clinic
 * account. 1:M off clinic_profiles.user_id, mirroring DoctorDocument.
 *
 * `docType` is a free STRING rather than an ENUM (unlike DoctorDocument) so the
 * accepted paperwork can change without a migration; the allowed values are
 * enforced by the Joi validator against CLINIC_DOC_TYPES.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ClinicDocument = sequelize.define(
  "ClinicDocument",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    docType: { type: DataTypes.STRING(50), allowNull: false },
    fileUrl: { type: DataTypes.STRING(512), allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: true },
    /** Storage driver key, so the file can be deleted when the row is. */
    storageKey: { type: DataTypes.STRING(512), allowNull: true },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "clinic_documents", timestamps: false }
);

module.exports = ClinicDocument;
