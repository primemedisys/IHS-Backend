/**
 * Maps `provider_payment_qr` (migration 044) — a provider's OWN UPI QR code
 * that patients scan to pay them directly. One row per provider user (doctor,
 * medicine store, pharmacy hospital), keyed on the user id, created on first
 * save.
 *
 * The platform never sees or verifies the money: a payment made to this QR
 * stays pending until the provider confirms it reached their UPI app.
 * A QR is "configured" — offered to patients — only while it is active AND
 * has an image.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ProviderPaymentQr = sequelize.define(
  "ProviderPaymentQr",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    /** The upload service's URL of the QR image (PNG / JPEG / WebP). */
    qrImageUrl: { type: DataTypes.STRING(500), allowNull: true },
    upiId: { type: DataTypes.STRING(100), allowNull: true },
    /** The name the patient should see on the payee line; falls back to the provider's name. */
    payeeName: { type: DataTypes.STRING(150), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "provider_payment_qr", timestamps: true }
);

module.exports = ProviderPaymentQr;
