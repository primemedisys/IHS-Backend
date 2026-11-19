/**
 * Maps `clinic_availability` (docs/dbstruct.md §9) — a clinic's weekly recurring
 * slots (PRD §4.3a: each clinic has its own schedule). 1:M off clinics.id. The
 * whole weekly set is replaced atomically by availability.service (never per-row
 * CRUD) so a schedule can't end up half-saved.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ClinicAvailability = sequelize.define(
  "ClinicAvailability",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    dayOfWeek: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false }, // 0=Sun..6=Sat
    startTime: { type: DataTypes.TIME, allowNull: false },
    endTime: { type: DataTypes.TIME, allowNull: false },
    /**
     * Since the consultation-queue migration (027) this is EXPECTED MINUTES PER
     * PATIENT, not a slot length — it no longer slices the window into bookable
     * times, it seeds the queue's waiting estimate. Kept under its old name so
     * the rename does not ripple through two validators and three frontends;
     * serializers expose it as `avgConsultMinutes`.
     */
    slotDurationMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 15 },
    /** Optional cap on tokens for a day built from this window; NULL = unlimited. */
    maxBookings: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "clinic_availability", timestamps: false }
);

module.exports = ClinicAvailability;
