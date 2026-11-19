/**
 * Maps the `sub_specializations` lookup (docs/bugfix-05-09-2026/doctor-specialization-sub-specialization.md).
 * Each sub-specialization belongs to a parent specialization (1:M).
 * Seeded by subSpecializations.seeder.js. Read-only from the app's perspective.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SubSpecialization = sequelize.define(
  "SubSpecialization",
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    slug: { type: DataTypes.STRING(150), allowNull: false, unique: true },
    specializationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  },
  { tableName: "sub_specializations", timestamps: false }
);

module.exports = SubSpecialization;
