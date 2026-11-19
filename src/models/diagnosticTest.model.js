/**
 * Maps `diagnostic_tests` (migration 038) — a Diagnostic Lab Center's own
 * catalogue of tests it offers (MRI, CBC, X-Ray, …) with its price and whether
 * it is currently available. Nothing is seeded or hard-coded: every lab
 * maintains its own list.
 *
 * Not a medicine: diagnostic tests share no model with the pharmacy inventory.
 * `isActive = false` is a soft delete, so answers already sent to patients
 * (diagnostic_request_tests) keep their FK.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DiagnosticTest = sequelize.define(
  "DiagnosticTest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    labId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "diagnostic_tests",
    timestamps: true,
    indexes: [{ fields: ["lab_id", "is_active"], name: "idx_dt_lab" }],
  }
);

module.exports = DiagnosticTest;
