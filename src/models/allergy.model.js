/**
 * Maps the `allergies` lookup (docs/dbstruct.md §2a). A small, reusable list of
 * allergy names ("Penicillin", "Peanuts"…) shared across patients via the
 * `patient_allergies` junction — so allergies are queryable and consistent
 * rather than free text. Find-or-created by name when a patient records one.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Allergy = sequelize.define(
  "Allergy",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  },
  { tableName: "allergies", timestamps: false }
);

module.exports = Allergy;
