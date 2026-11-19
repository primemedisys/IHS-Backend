/**
 * Maps `prescription_items` (migration 006) — the medicine rows of one
 * prescription, ordered by `sortOrder`. Written replace-the-set (destroy +
 * bulkCreate in one transaction), so there is no updatedAt to maintain and the
 * table carries no timestamps.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PrescriptionItem = sequelize.define(
  "PrescriptionItem",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    prescriptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** Optional reference to the doctor's medicine master list. */
    medicineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The IHS catalogue row (medicine_masters) the line was picked from — migration 053. */
    medicineMasterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The printed label ("Pan 40 40 mg") — every existing reader shows this. */
    medicineName: { type: DataTypes.STRING(200), allowNull: false },
    // Migration 053: the medicine's own strength and dosage form, kept apart
    // from `dosage` (the dose the doctor prescribes). Copied from the picked
    // catalogue / own-list row, never invented.
    strength: { type: DataTypes.STRING(100), allowNull: true },
    dosageForm: { type: DataTypes.STRING(50), allowNull: true },
    dosage: { type: DataTypes.STRING(100), allowNull: true },
    route: {
      type: DataTypes.ENUM("oral", "topical", "injection", "drops", "inhaler", "other"),
      allowNull: false,
      defaultValue: "oral",
    },
    frequency: { type: DataTypes.STRING(100), allowNull: true },
    timing: {
      type: DataTypes.ENUM("before_food", "after_food", "with_food", "anytime"),
      allowNull: true,
      defaultValue: "after_food",
    },
    durationDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    // The UNIT `durationDays` counts in (migration 015). Named for the
    // column it qualifies; `durationDays: 3, durationUnit: "month"` is
    // three months. Defaults to `day`, so pre-015 rows are unchanged.
    durationUnit: {
      type: DataTypes.ENUM("day", "week", "month"),
      allowNull: false,
      defaultValue: "day",
    },
    // Migration 051 — all optional; never inferred, only what the doctor typed.
    quantity: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    priority: { type: DataTypes.ENUM("routine", "urgent", "stat"), allowNull: true },
    nameType: { type: DataTypes.ENUM("trade", "generic"), allowNull: true },
    notes: { type: DataTypes.STRING(255), allowNull: true },
  },
  { tableName: "prescription_items", timestamps: false }
);

module.exports = PrescriptionItem;
