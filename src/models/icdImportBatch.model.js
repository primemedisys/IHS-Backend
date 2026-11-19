const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * One confirmed Excel import into the ICD & Diagnosis Master (migration 060):
 * the audit record of who imported which file, into which version, with which
 * duplicate policy, and the outcome. Written once; never edited.
 */
const IcdImportBatch = sequelize.define(
  "IcdImportBatch",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    fileName: { type: DataTypes.STRING(255), allowNull: false },
    fileSha256: { type: DataTypes.CHAR(64), allowNull: false },
    systemVersion: { type: DataTypes.STRING(30), allowNull: false },
    duplicatePolicy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "skip" },
    /** completed | failed */
    status: { type: DataTypes.STRING(12), allowNull: false },
    totalRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    validRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    invalidRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    duplicateFileRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    existingRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    insertedRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    updatedRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    skippedRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** [{ codingSystem, rows }] */
    systems: { type: DataTypes.JSON, allowNull: true },
    /** First rejected rows: [{ rowNumber, code, errors[] }] */
    errorSample: { type: DataTypes.JSON, allowNull: true },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    importedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "icd_import_batches",
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ["created_at"], name: "idx_iib_created" }],
  }
);

module.exports = IcdImportBatch;
