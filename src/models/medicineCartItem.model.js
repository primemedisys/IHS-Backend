/**
 * Maps `medicine_cart_items` — THE cart. One row is one patient holding one
 * provider's inventory row (`medicine_store_medicines.id`) at a quantity.
 *
 * Deliberately stores no money and no provider columns. The inventory row it
 * points at already carries the provider, the provider type, that provider's
 * OWN price and that provider's OWN stock, so a cart line can never end up
 * charging provider A's medicine at provider B's price. Price and stock are
 * re-read live on every cart read and again, under a row lock, at checkout.
 *
 * `prescriptionRequestId` is set when the line came from a pharmacy's
 * availability answer, so the resulting order stays linked to that shared
 * prescription (the existing prescription flow, not a second one).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineCartItem = sequelize.define(
  "MedicineCartItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    medicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    prescriptionRequestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_cart_items",
    timestamps: true,
    indexes: [
      // snake_case: index `fields` are passed to SQL literally (underscored
      // does not rewrite them) — see medicineMaster.model.
      { unique: true, fields: ["patient_id", "medicine_id"], name: "uq_mci_patient_medicine" },
      { fields: ["patient_id"], name: "idx_mci_patient" },
    ],
  }
);

module.exports = MedicineCartItem;
