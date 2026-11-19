/**
 * Maps `medicine_stock_batches` (migration 043) — batch-wise stock of ONE
 * provider inventory row. A batch never exists on its own: it always belongs
 * to the pharmacy's `medicine_store_medicines` row, so the global master stays
 * the medicine's identity and the inventory row stays its price and total.
 *
 * Invariant (kept by services/pharmacyStock.service.js, the only writer):
 *   inventory.stock = Σ quantity_available of its batches + untracked units
 * where "untracked" is stock that predates batch tracking or was entered
 * without a batch number.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineStockBatch = sequelize.define(
  "MedicineStockBatch",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    inventoryId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /** Upper-cased by the service; unique per inventory row. */
    batchNumber: { type: DataTypes.STRING(64), allowNull: false },
    /** "YYYY-MM-DD"; NULL when the pharmacy entered no expiry for the batch. */
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true },
    quantityReceived: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    quantityAvailable: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** Purchase rate per unit, excl. GST — private to the pharmacy. */
    buyingPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    supplierId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_stock_batches",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["inventory_id", "batch_number"], name: "uq_msb_inventory_batch" },
      { fields: ["provider_id", "expiry_date"], name: "idx_msb_provider_expiry" },
      { fields: ["supplier_id"], name: "idx_msb_supplier" },
    ],
  }
);

module.exports = MedicineStockBatch;
