/**
 * Maps the `conditions` lookup (docs/dbstruct.md §2b) — chronic conditions
 * ("Diabetes", "Hypertension"…) shared across patients via `patient_conditions`.
 * Same normalization as allergies: find-or-created by name.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Condition = sequelize.define(
  "Condition",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  },
  { tableName: "conditions", timestamps: false }
);

module.exports = Condition;
