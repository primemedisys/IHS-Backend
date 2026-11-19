/**
 * Maps `medicine_masters` — the GLOBAL medicine catalogue (migration 035).
 *
 * One row per distinct medicine product, shared by every MR / Medicine Store.
 * It describes the medicine itself (name, generic, form, strength,
 * manufacturer, category). Price and stock are NOT here — they belong to each
 * provider's own inventory row in `medicine_store_medicines`, which points
 * back via `medicine_master_id`.
 *
 * `identityKey` is the normalized NAME|STRENGTH|TYPE (utils/medicineIdentity)
 * and is UNIQUE, so "Jerodol-SP" and "JERODOL-SP" can never become two masters.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineMaster = sequelize.define(
  "MedicineMaster",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    medicineName: { type: DataTypes.STRING(255), allowNull: false },
    genericName: { type: DataTypes.STRING(255), allowNull: true },
    medicineType: { type: DataTypes.STRING(50), allowNull: false },
    strength: { type: DataTypes.STRING(100), allowNull: true },
    manufacturer: { type: DataTypes.STRING(255), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    identityKey: { type: DataTypes.STRING(420), allowNull: false },
    /** The provider (or admin) who first added it — audit only, not ownership. */
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The role of `createdBy` — doctor / pharmacy role / admin (migration 055). */
    createdByRole: { type: DataTypes.STRING(30), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_masters",
    timestamps: true,
    // snake_case: index `fields` are passed to SQL literally (underscored does
    // not rewrite them) — see docs/prescription-request-schema-fix-22-09-2026.
    indexes: [
      { unique: true, fields: ["identity_key"], name: "uq_mm_identity" },
      { fields: ["medicine_name"], name: "idx_mm_name" },
      { fields: ["category_id"], name: "idx_mm_category" },
    ],
  }
);

module.exports = MedicineMaster;
