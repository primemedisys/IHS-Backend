/**
 * Maps `payments` (docs/dbstruct.md §13) — (1:1) to a booking. Online payments
 * carry the Razorpay ids + the commission split; offline ("pay at clinic")
 * payments sit at `pending_at_clinic` until the doctor marks them paid.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { OFFLINE_PAYMENT_METHOD } = require("../config/constants");

const Payment = sequelize.define(
  "Payment",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    mode: { type: DataTypes.ENUM("online", "offline"), allowNull: false },
    /**
     * How an OFFLINE payment is collected (migration 044): cash at the clinic,
     * or the doctor's own UPI QR. NULL on online payments and on offline rows
     * written before the column existed (read as cash).
     */
    offlineMethod: {
      type: DataTypes.ENUM(...Object.values(OFFLINE_PAYMENT_METHOD)),
      allowNull: true,
    },
    /** The UPI transaction id / UTR the patient REPORTED — unverified, for the doctor to check. */
    payerReference: { type: DataTypes.STRING(64), allowNull: true },
    /** When the patient said "I have paid". Never changes the payment status. */
    payerReportedAt: { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM("initiated", "success", "failed", "refunded", "pending_at_clinic"),
      allowNull: false,
      defaultValue: "initiated",
    },
    razorpayOrderId: { type: DataTypes.STRING(100), allowNull: true },
    razorpayPaymentId: { type: DataTypes.STRING(100), allowNull: true },
    razorpaySignature: { type: DataTypes.STRING(255), allowNull: true },
    commissionAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    doctorPayoutAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    // Refund bookkeeping (migration 007). Nothing writes these yet — the
    // refunds plan does. The earnings aggregates already READ them so that when
    // a refund lands it doesn't retroactively rewrite the month it was paid in.
    refundedAt: { type: DataTypes.DATE, allowNull: true },
    refundAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "payments", timestamps: false }
);

module.exports = Payment;
