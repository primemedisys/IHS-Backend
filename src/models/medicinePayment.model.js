/**
 * Maps `medicine_payments` — one payment ATTEMPT against one order group, and
 * the seam a real gateway will be dropped into.
 *
 * In this phase `gateway` is always "simulated": no gateway SDK, no keys, no
 * money moves, and `reference` is an obviously-synthetic "SIM-…" string so a
 * simulated attempt can never be mistaken for a bank transaction. Adding a
 * real processor later means writing a new gateway value (plus its own id
 * columns) here — the order, billing and notification code above this table
 * reads only `status`/`amount` and does not change.
 *
 * `idempotencyKey` is UNIQUE, so a repeated pay request (double click, retried
 * callback) can never produce a second charge or a second order.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  MEDICINE_PAYMENT_METHOD,
  MEDICINE_PAYMENT_GATEWAY,
  MEDICINE_PAYMENT_ATTEMPT_STATUS,
} = require("../config/constants");

const MedicinePayment = sequelize.define(
  "MedicinePayment",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    orderGroupId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    method: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PAYMENT_METHOD)),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PAYMENT_ATTEMPT_STATUS)),
      allowNull: false,
      defaultValue: MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING,
    },
    gateway: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: MEDICINE_PAYMENT_GATEWAY.SIMULATED,
    },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    /**
     * UPI QR orders (migration 044): the UPI transaction id / UTR the patient
     * REPORTED, and when. Unverified — the pharmacy checks its UPI app and
     * confirms receipt; reporting never changes `status`.
     */
    payerReference: { type: DataTypes.STRING(64), allowNull: true },
    payerReportedAt: { type: DataTypes.DATE, allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(100), allowNull: true },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_payments",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["idempotency_key"], name: "uq_mp_idempotency" },
      { fields: ["order_group_id"], name: "idx_mp_group" },
    ],
  }
);

module.exports = MedicinePayment;
