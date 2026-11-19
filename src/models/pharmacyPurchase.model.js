/**
 * Maps `pharmacy_purchases` (migration 043) — one supplier purchase invoice
 * recorded by a pharmacy: stock IN. The money columns are what
 * pharmacyPurchase.service computed from the lines (buying price × quantity,
 * less discount, plus GST) — a client total is never stored.
 *
 * A purchase is recorded on receipt (`received`) and can only ever be
 * `cancelled`, which reverses its stock; it is never edited in place, so the
 * stock ledger and the invoice can never disagree.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { PURCHASE_STATUS } = require("../config/pharmacy");

const PharmacyPurchase = sequelize.define(
  "PharmacyPurchase",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    /** PO-YYYYMMDD-000123, stamped after insert from the primary key. */
    purchaseNumber: { type: DataTypes.STRING(32), allowNull: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    supplierId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The supplier's own invoice number, as printed on their bill. */
    invoiceNumber: { type: DataTypes.STRING(64), allowNull: false },
    invoiceDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(PURCHASE_STATUS)),
      allowNull: false,
      defaultValue: PURCHASE_STATUS.RECEIVED,
    },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    itemCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    discountTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    taxableTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    gstTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    totalAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "pharmacy_purchases",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["purchase_number"], name: "uq_pp_number" },
      { fields: ["provider_id", "invoice_date"], name: "idx_pp_provider_date" },
      { fields: ["supplier_id"], name: "idx_pp_supplier" },
    ],
  }
);

module.exports = PharmacyPurchase;
