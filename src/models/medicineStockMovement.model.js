/**
 * Maps `medicine_stock_movements` (migration 043) — the stock ledger. Every
 * change to an inventory row's stock writes one row per batch it touched:
 * signed `quantity` (+in / −out), the stock level right after it, and what
 * caused it (`referenceType` + `referenceId`: an order line, a purchase item,
 * a return item, an import).
 *
 * A sale's rows record WHICH batch each unit left, which is how a cancel,
 * rejection or return puts units back on exactly that batch. Append-only:
 * nothing updates or deletes a movement.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { STOCK_MOVEMENT_TYPE } = require("../config/pharmacy");

const MedicineStockMovement = sequelize.define(
  "MedicineStockMovement",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    inventoryId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /** NULL for untracked (non-batch) units. */
    batchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    movementType: {
      type: DataTypes.ENUM(...Object.values(STOCK_MOVEMENT_TYPE)),
      allowNull: false,
    },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    stockAfter: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    referenceType: { type: DataTypes.STRING(30), allowNull: true },
    referenceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    note: { type: DataTypes.STRING(255), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_stock_movements",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["inventory_id", "created_at"], name: "idx_msmv_inventory" },
      { fields: ["reference_type", "reference_id"], name: "idx_msmv_reference" },
      { fields: ["provider_id", "created_at"], name: "idx_msmv_provider" },
      { fields: ["batch_id"], name: "idx_msmv_batch" },
    ],
  }
);

module.exports = MedicineStockMovement;
