/**
 * Maps `doctor_documents` (docs/dbstruct.md §7) — uploaded verification files
 * (degree / ID / council registration). 1:M off doctor_profiles.user_id.
 * `fileUrl` is whatever the storage driver returned (local URL or S3 object URL).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { DOC_TYPES } = require("../config/constants");

const DoctorDocument = sequelize.define(
  "DoctorDocument",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    docType: { type: DataTypes.ENUM(...Object.values(DOC_TYPES)), allowNull: false },
    fileUrl: { type: DataTypes.STRING(500), allowNull: false },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "doctor_documents", timestamps: false }
);

module.exports = DoctorDocument;
