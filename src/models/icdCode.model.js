const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * One row of the admin-managed diagnosis / ICD catalogue (migration 059).
 *
 * A code only means something inside its coding system AND version — ICD-10
 * (WHO), ICD-10-CM and ICD-11 are different classifications — so uniqueness is
 * (codingSystem, systemVersion, code). Rows are never hard-deleted: an admin
 * deactivates one, and diagnoses already recorded with it keep their own
 * snapshot (clinical_entries.code / code_system / code_version / code_description).
 */
const IcdCode = sequelize.define(
  "IcdCode",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    codingSystem: { type: DataTypes.STRING(20), allowNull: false },
    systemVersion: { type: DataTypes.STRING(30), allowNull: false },
    code: { type: DataTypes.STRING(20), allowNull: false },
    /** The diagnosis name doctors search and see. */
    title: { type: DataTypes.STRING(255), allowNull: false },
    /** The official description from the source classification. */
    description: { type: DataTypes.STRING(1000), allowNull: true },
    category: { type: DataTypes.STRING(150), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    updatedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "icd_codes",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["coding_system", "system_version", "code"], name: "uq_icd_system_code" },
      { fields: ["title"], name: "idx_icd_title" },
      { fields: ["is_active", "coding_system", "system_version"], name: "idx_icd_active" },
    ],
  }
);

module.exports = IcdCode;
