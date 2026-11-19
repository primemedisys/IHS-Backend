/**
 * Maps `medicine_store_medicines` — a provider's OWN inventory row: one MR /
 * Medicine Store selling one medicine at its own price and stock.
 *
 * The medicine's identity lives in the global `medicine_masters` catalogue
 * (`medicineMasterId`, migration 035). The descriptive columns here
 * (medicineName, genericName, medicineType, strength, manufacturer,
 * description, categoryId) are a snapshot copied from the master when the row
 * is created, so the existing order / prescription / patient readers that
 * include this model keep working unchanged. Providers can only edit the
 * provider-specific fields (price, stock, location, image, active).
 *
 * Pharmacy management (migration 043) adds the provider's own commercial
 * data — see config/pharmacy.js for the price conventions:
 *   price          selling price per unit, GST-INCLUSIVE, before discount
 *   discountPercent the pharmacy's item discount on that price
 *   buyingPrice    purchase rate per unit, excl. GST — PRIVATE (never sent to
 *                  a patient; see PRIVATE_INVENTORY_ATTRS in medicineStore.service)
 *   gstRate / hsnCode / mrp / packSize / sku / minStock (reorder level)
 *   batchNumber / expiryDate  a SUMMARY of the nearest-expiring batch that
 *                  still has stock, maintained by pharmacyStock.service from
 *                  medicine_stock_batches (the batch truth) — never edited directly
 *   supplierId     the supplier this medicine was last bought from
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { MEDICINE_PROVIDER_TYPE } = require("../config/constants");
const { DEFAULT_MIN_STOCK } = require("../config/pharmacy");

const MedicineStoreMedicine = sequelize.define(
  "MedicineStoreMedicine",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerType: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PROVIDER_TYPE)),
      allowNull: false,
    },
    categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** Global medicine this inventory row sells (migration 035; NULL only before backfill). */
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The pharmacy's own item code (optional, migration 043). */
    sku: { type: DataTypes.STRING(64), allowNull: true },
    medicineName: { type: DataTypes.STRING(255), allowNull: false },
    genericName: { type: DataTypes.STRING(255), allowNull: true },
    medicineType: { type: DataTypes.STRING(50), allowNull: false },
    strength: { type: DataTypes.STRING(100), allowNull: true },
    manufacturer: { type: DataTypes.STRING(255), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    hsnCode: { type: DataTypes.STRING(20), allowNull: true },
    packSize: { type: DataTypes.STRING(50), allowNull: true },
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    buyingPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    gstRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    stock: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    minStock: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: DEFAULT_MIN_STOCK },
    batchNumber: { type: DataTypes.STRING(64), allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true },
    supplierId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    location: { type: DataTypes.STRING(255), allowNull: true },
    imageUrl: { type: DataTypes.STRING(512), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "medicine_store_medicines", timestamps: true }
);

module.exports = MedicineStoreMedicine;
