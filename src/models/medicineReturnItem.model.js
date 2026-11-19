/**
 * Maps `medicine_return_items` (migration 043) — the returned quantity of one
 * order line (`medicine_orders`) on a credit note, with that quantity's share
 * of the line's charged amount and GST.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineReturnItem = sequelize.define(
  "MedicineReturnItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    returnId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    orderLineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    medicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineName: { type: DataTypes.STRING(255), allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    /** The net (after-discount) unit price the patient paid on that line. */
    unitPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    gstRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    taxableAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    gstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    lineTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_return_items",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["return_id"], name: "idx_mri_return" },
      { fields: ["order_line_id"], name: "idx_mri_line" },
    ],
  }
);

module.exports = MedicineReturnItem;
