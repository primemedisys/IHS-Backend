/**
 * Maps `pharmacy_profiles` (migration 043) — the store details a bill needs
 * that the `users` row does not carry (GSTIN, drug licence number, a footer
 * note) plus the pharmacy's own "expiring soon" window. One row per pharmacy,
 * created on first save; until then every reader uses the defaults in
 * config/pharmacy.js.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { DEFAULT_EXPIRY_ALERT_DAYS } = require("../config/pharmacy");

const PharmacyProfile = sequelize.define(
  "PharmacyProfile",
  {
    providerId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    gstin: { type: DataTypes.STRING(15), allowNull: true },
    drugLicenseNumber: { type: DataTypes.STRING(64), allowNull: true },
    expiryAlertDays: {
      type: DataTypes.SMALLINT.UNSIGNED,
      allowNull: false,
      defaultValue: DEFAULT_EXPIRY_ALERT_DAYS,
    },
    invoiceNote: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "pharmacy_profiles", timestamps: true }
);

module.exports = PharmacyProfile;
