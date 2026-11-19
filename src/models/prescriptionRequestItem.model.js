/**
 * Maps `prescription_request_items` — the per-medicine answer a provider gives
 * when they check a shared prescription against their own inventory.
 *
 * One row per medicine on the prescription:
 *   - `available`: linked to the provider's own listing (`medicine_id`) with the
 *     quantity they can supply and the price at that moment.
 *   - `unavailable`: a free-text medicine name (the provider states what they
 *     don't stock) with an optional short reason.
 *
 * A re-submit REPLACES the whole set for the request (delete + insert inside a
 * transaction), so this table never accumulates stale generations.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PrescriptionRequestItem = sequelize.define(
  "PrescriptionRequestItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    prescriptionRequestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    medicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    medicineName: { type: DataTypes.STRING(255), allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    status: {
      type: DataTypes.ENUM("available", "unavailable"),
      allowNull: false,
    },
    reason: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "prescription_request_items",
    timestamps: true,
    indexes: [
      { fields: ["prescription_request_id"], name: "idx_pri_request" },
      { fields: ["status"], name: "idx_pri_status" },
    ],
  }
);

module.exports = PrescriptionRequestItem;