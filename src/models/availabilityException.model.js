/**
 * Maps `availability_exceptions` (docs/dbstruct.md §11) — blocked/leave dates.
 * 1:M off doctor_profiles.user_id (as `doctorId`), optionally scoped to one
 * clinic. A NULL `clinicId` means the exception applies to the online schedule.
 * The slot-preview expander returns [] for a date that has a matching exception.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AvailabilityException = sequelize.define(
  "AvailabilityException",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // NULL = online exception
    exceptionDate: { type: DataTypes.DATEONLY, allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: true },
  },
  { tableName: "availability_exceptions", timestamps: false }
);

module.exports = AvailabilityException;
