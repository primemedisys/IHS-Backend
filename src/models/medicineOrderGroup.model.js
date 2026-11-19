/**
 * Maps `medicine_order_groups` — one checkout against one pharmacy: the order
 * header the patient sees as "Order #…" and the row the bill is rendered from.
 *
 * The existing `medicine_orders` rows are unchanged and become this group's
 * LINES (one per medicine, each keeping its own provider-specific unit price),
 * which is why the pharmacy's per-medicine order management keeps working.
 * A cart spanning two pharmacies produces two groups — a group is always
 * exactly one patient and one provider, so provider-specific price, stock and
 * ownership stay intact all the way through delivery.
 *
 * Every money column is what the SERVER computed from the provider's live
 * price × the validated quantity. Nothing here is ever taken from a client.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  MEDICINE_PROVIDER_TYPE,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_PAYMENT_METHOD,
} = require("../config/constants");

const MedicineOrderGroup = sequelize.define(
  "MedicineOrderGroup",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    /** Human-facing bill/order number, e.g. "MO-20260922-000123". Stamped after insert. */
    orderNumber: { type: DataTypes.STRING(32), allowNull: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerType: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PROVIDER_TYPE)),
      allowNull: false,
    },
    itemCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** Σ unitPrice × quantity over the lines — before item discounts. */
    subtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    /** Σ line discounts (migration 043; 0 on older orders). */
    discountTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    /**
     * The GST INCLUDED in totalAmount, split into taxable value + tax
     * (migration 043). taxableTotal is NULL on orders placed before GST data
     * was recorded. Prices are GST-inclusive, so GST never adds to the total.
     */
    taxableTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    gstTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    /**
     * What the patient owes: subtotal − discountTotal. The platform charges no
     * delivery fee, so none is added here.
     */
    totalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    paymentMethod: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PAYMENT_METHOD)),
      allowNull: false,
      defaultValue: MEDICINE_PAYMENT_METHOD.COD,
    },
    paymentStatus: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_ORDER_PAYMENT_STATUS)),
      allowNull: false,
      defaultValue: MEDICINE_ORDER_PAYMENT_STATUS.PENDING,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_ORDER_STATUS)),
      allowNull: false,
      defaultValue: MEDICINE_ORDER_STATUS.PENDING,
    },
    // Structured delivery location — the same city/state/lat/lng shape the
    // provider's registered Google location uses, so the two are comparable.
    deliveryAddress: { type: DataTypes.STRING(500), allowNull: true },
    deliveryCity: { type: DataTypes.STRING(100), allowNull: true },
    deliveryState: { type: DataTypes.STRING(100), allowNull: true },
    deliveryPincode: { type: DataTypes.STRING(20), allowNull: true },
    deliveryLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    deliveryLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    /** Set when the order came off a shared prescription (existing rx flow). */
    prescriptionRequestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** When the order became real to the pharmacy (COD: at checkout; online: at payment success). */
    placedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_order_groups",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["order_number"], name: "uq_mog_number" },
      { fields: ["patient_id"], name: "idx_mog_patient" },
      { fields: ["provider_id", "status"], name: "idx_mog_provider" },
    ],
  }
);

module.exports = MedicineOrderGroup;
