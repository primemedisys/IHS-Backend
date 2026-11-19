/**
 * Maps `medicine_master_images` (migration 037) — package / strip photos of a
 * GLOBAL medicine. Images describe the medicine itself, so they hang off the
 * master (1:M), never off a provider's inventory row: "Jerodol-SP" has one set
 * of photos however many pharmacies sell it.
 *
 * `imageUrl` + `storageKey` come from upload.service.put() — the same storage
 * (local disk / S3) every other upload in the app uses. `sortOrder` 0 is the
 * primary image shown on cards.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineMasterImage = sequelize.define(
  "MedicineMasterImage",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    imageUrl: { type: DataTypes.STRING(512), allowNull: false },
    storageKey: { type: DataTypes.STRING(512), allowNull: true },
    sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** Provider / admin who uploaded it — the only non-admin allowed to delete it. */
    uploadedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_master_images",
    timestamps: true,
    indexes: [{ fields: ["medicine_master_id", "sort_order"], name: "idx_mmi_master_order" }],
  }
);

module.exports = MedicineMasterImage;
