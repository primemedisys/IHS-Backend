/**
 * Maps `medicine_returns` (migration 043) — a return against ONE delivered
 * order (medicine_order_groups), and the credit note it produces
 * (`creditNoteNumber`, CN-YYYYMMDD-000123). The amounts are the returned
 * share of what the patient was actually charged on each line, computed by
 * medicineReturn.service; `restocked` says whether the units went back on the
 * shelf (sealed, in date) or were not resaleable.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineReturn = sequelize.define(
  "MedicineReturn",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    creditNoteNumber: { type: DataTypes.STRING(32), allowNull: true },
    orderGroupId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    restocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    itemCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    taxableTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    gstTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    refundAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_returns",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["credit_note_number"], name: "uq_mr_credit_note" },
      { fields: ["provider_id", "created_at"], name: "idx_mr_provider_date" },
      { fields: ["order_group_id"], name: "idx_mr_group" },
    ],
  }
);

module.exports = MedicineReturn;
