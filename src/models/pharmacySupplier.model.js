/**
 * Maps `pharmacy_suppliers` (migration 043) — a pharmacy's OWN suppliers
 * (distributors / wholesalers it buys from). Private to that pharmacy: every
 * read and write in pharmacySupplier.service is scoped by `providerId`, and a
 * name is unique per pharmacy (uq_ps_provider_name, case-insensitive collation).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PharmacySupplier = sequelize.define(
  "PharmacySupplier",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    contactPerson: { type: DataTypes.STRING(150), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },
    gstin: { type: DataTypes.STRING(15), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "pharmacy_suppliers",
    timestamps: true,
    indexes: [{ unique: true, fields: ["provider_id", "name"], name: "uq_ps_provider_name" }],
  }
);

module.exports = PharmacySupplier;
