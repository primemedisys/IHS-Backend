/**
 * Maps `medicine_categories` — a taxonomy for medicine categories
 * (e.g. "Antibiotics", "Pain Relievers"). Used to classify medicines
 * listed by medicine stores and MRs.
 *
 * Categories are GLOBAL: every MR, Medicine Store and patient sees the same
 * list. `provider_id` / `provider_type` only record which provider first
 * created the category (audit) — they do NOT scope visibility or ownership.
 * Names are unique case-insensitively (uq_mc_name under the table's `_ci`
 * collation, plus the normalized lookup in medicineStore.service).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { MEDICINE_PROVIDER_TYPE } = require("../config/constants");

const MedicineCategory = sequelize.define(
  "MedicineCategory",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    slug: { type: DataTypes.STRING(150), allowNull: false },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    providerType: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PROVIDER_TYPE)),
      allowNull: true,
    },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_categories",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["name"], name: "uq_mc_name" },
      { unique: true, fields: ["slug"], name: "uq_mc_slug" },
      { fields: ["provider_id", "provider_type"], name: "idx_mc_provider" },
    ],
  }
);

module.exports = MedicineCategory;
