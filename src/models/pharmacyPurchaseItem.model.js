/**
 * Maps `pharmacy_purchase_items` (migration 043) — one medicine line on a
 * supplier purchase. It points at the pharmacy's OWN inventory row (the
 * medicine it now stocks) and at the batch the units went into; the name /
 * batch / expiry / prices are a snapshot so the purchase reads the same even
 * after the inventory changes.
 *
 * Money (per line): gross = quantity × buyingPrice; discount = gross × d%;
 * taxable = gross − discount; gst = taxable × gstRate%; lineTotal = taxable + gst.
 * Free units add stock but no cost.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PharmacyPurchaseItem = sequelize.define(
  "PharmacyPurchaseItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    purchaseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    inventoryId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    batchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineName: { type: DataTypes.STRING(255), allowNull: false },
    batchNumber: { type: DataTypes.STRING(64), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    freeQuantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    buyingPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    /** Set when this purchase also changed the pharmacy's selling price. */
    sellingPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    gstRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    grossAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    discountAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    taxableAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    gstAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    lineTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "pharmacy_purchase_items",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["purchase_id"], name: "idx_ppi_purchase" },
      { fields: ["inventory_id"], name: "idx_ppi_inventory" },
      { fields: ["batch_id"], name: "idx_ppi_batch" },
    ],
  }
);

module.exports = PharmacyPurchaseItem;
