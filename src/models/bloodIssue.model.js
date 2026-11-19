/**
 * Maps `blood_issues` (migration 039): a unit handed over against a request.
 * Always references the active reservation and a `compatible` cross-match; a
 * unit can be issued once (UNIQUE unit_id). Written in the same transaction
 * that moves the unit to `issued`.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const BloodIssue = sequelize.define(
  "BloodIssue",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    issueCode: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_bis_code" },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    unitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: "uq_bis_unit" },
    reservationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    crossmatchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    issuedToName: { type: DataTypes.STRING(150), allowNull: false },
    hospitalName: { type: DataTypes.STRING(200), allowNull: false },
    issuedByName: { type: DataTypes.STRING(150), allowNull: false },
    verifiedByName: { type: DataTypes.STRING(150), allowNull: false },
    issuedAt: { type: DataTypes.DATE, allowNull: false },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    recordedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_issues",
    timestamps: true,
    indexes: [
      { fields: ["request_id"], name: "idx_bis_request" },
      { fields: ["blood_bank_id", "issued_at"], name: "idx_bis_bank" },
    ],
  }
);

module.exports = BloodIssue;
