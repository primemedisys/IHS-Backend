/**
 * Maps `blood_units` (migration 039): one traceable bag. Inventory is DERIVED
 * from these rows (there is no separate inventory table to drift).
 *
 * Lifecycle (UNIT_STATUS): quarantine -> testing -> available -> reserved ->
 * issued, or discarded / expired; a whole-blood unit separated into components
 * becomes `processed` and its children carry `parentUnitId`. Every change goes
 * through the blood-bank services under a row lock and is audited.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodUnit = sequelize.define(
  "BloodUnit",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    unitCode: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_bu_code" },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    donorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    parentUnitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    bloodGroup: { type: DataTypes.ENUM(...B.BLOOD_GROUPS), allowNull: false },
    /** A key of config/bloodBank.js BLOOD_COMPONENTS (VARCHAR, so it stays configurable). */
    component: { type: DataTypes.STRING(30), allowNull: false },
    volumeMl: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    collectedAt: { type: DataTypes.DATE, allowNull: false },
    processedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    testingStatus: { type: DataTypes.ENUM(...Object.values(B.TESTING_STATUS)), allowNull: false, defaultValue: B.TESTING_STATUS.PENDING },
    status: { type: DataTypes.ENUM(...Object.values(B.UNIT_STATUS)), allowNull: false, defaultValue: B.UNIT_STATUS.QUARANTINE },
    storageLocation: { type: DataTypes.STRING(100), allowNull: true },
    releasedByName: { type: DataTypes.STRING(150), allowNull: true },
    releasedAt: { type: DataTypes.DATE, allowNull: true },
    discardReason: { type: DataTypes.STRING(255), allowNull: true },
    discardedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    updatedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_units",
    timestamps: true,
    indexes: [
      { fields: ["blood_bank_id", "status", "blood_group", "component"], name: "idx_bu_inventory" },
      { fields: ["blood_bank_id", "status", "expires_at"], name: "idx_bu_expiry" },
      { fields: ["donation_id"], name: "idx_bu_donation" },
      { fields: ["parent_unit_id"], name: "idx_bu_parent" },
    ],
  }
);

module.exports = BloodUnit;
