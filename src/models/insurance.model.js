/**
 * Maps `insurances` (docs/dbstruct.md §6m) — the insurance-provider lookup a
 * doctor picks from (M:N via doctor_insurances). Mirrors specialization/language.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Insurance = sequelize.define(
  "Insurance",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
  },
  { tableName: "insurances", timestamps: false }
);

module.exports = Insurance;
