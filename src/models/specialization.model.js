/**
 * Maps the `specializations` lookup (docs/dbstruct.md §4). Seeded by the base
 * schema. Read-only from the app's perspective — the specialty picker and
 * discovery filters read this list.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Specialization = sequelize.define(
  "Specialization",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    slug: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  },
  { tableName: "specializations", timestamps: false }
);

module.exports = Specialization;
