/**
 * Maps `medicine_master_substitutes` (migration 037) — "B can substitute for
 * A", as a self-referencing M:N between GLOBAL medicine masters. A substitute
 * is a reference to an existing master, never a copy, so its price and stock
 * always come from real provider inventory rows.
 *
 * Directional: a row (A → B) lists B on A's page. B's own substitute list is
 * its own set of rows, so editing A never silently rewrites B.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineMasterSubstitute = sequelize.define(
  "MedicineMasterSubstitute",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    substituteMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "medicine_master_substitutes",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { unique: true, fields: ["medicine_master_id", "substitute_master_id"], name: "uq_mms_pair" },
      { fields: ["substitute_master_id"], name: "idx_mms_substitute" },
    ],
  }
);

module.exports = MedicineMasterSubstitute;
