/**
 * Maps the `languages` lookup (docs/dbstruct.md §5). Seeded by the base schema.
 * Read-only — feeds the languages multi-select.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Language = sequelize.define(
  "Language",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(60), allowNull: false, unique: true },
  },
  { tableName: "languages", timestamps: false }
);

module.exports = Language;
