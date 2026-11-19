/**
 * Maps `medicine_orders` — a patient's order for a medicine from a provider
 * (medicine store or MR). Tracks order lifecycle from pending through delivery,
 * along with payment status.
 *
 * Migration 043 snapshots, at the moment the order is placed, everything the
 * bill and the reports need so a later price / GST / cost change can never
 * rewrite a past sale:
 *   unitPrice      selling price per unit BEFORE discount (GST-inclusive)
 *   discountAmount the line's item discount;  totalPrice = unitPrice × qty − discount
 *   gstRate / taxableAmount / gstAmount — the GST INCLUDED in totalPrice
 *   unitCost       the pharmacy's buying price per unit — PRIVATE (provider only)
 *   mrp / hsnCode / batchNumber / expiryDate — as printed on the bill
 * Lines placed before 043 have taxableAmount NULL (no tax data was recorded).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  MEDICINE_PROVIDER_TYPE,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_PAYMENT_STATUS,
} = require("../config/constants");

const MedicineOrder = sequelize.define(
  "MedicineOrder",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /**
     * The checkout this line belongs to (migration 036). NULL on the orders
     * placed before groups existed — every reader treats a NULL group as a
     * single-line order, so no historical row had to be rewritten.
     */
    orderGroupId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerType: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PROVIDER_TYPE)),
      allowNull: false,
    },
    medicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    unitPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    discountAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    gstRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    taxableAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    gstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    unitCost: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    hsnCode: { type: DataTypes.STRING(20), allowNull: true },
    /** The first batch the units came from (all batches are in the stock ledger). */
    batchNumber: { type: DataTypes.STRING(64), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true },
    totalPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_ORDER_STATUS)),
      allowNull: false,
      defaultValue: MEDICINE_ORDER_STATUS.PENDING,
    },
    paymentStatus: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_ORDER_PAYMENT_STATUS)),
      allowNull: false,
      defaultValue: MEDICINE_ORDER_PAYMENT_STATUS.PENDING,
    },
    deliveryAddress: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    /** Set when the order was placed off a shared prescription (migration 033). */
    prescriptionRequestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "medicine_orders" }
);

module.exports = MedicineOrder;
