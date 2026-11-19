/**
 * Maps `doctor_online_availability` (docs/dbstruct.md §10) — the doctor's
 * independent weekly schedule for video consults (PRD §4.3a), not tied to any
 * clinic. 1:M off doctor_profiles.user_id (as `doctorId`). Same slot shape as
 * clinic_availability; replaced as a whole set by availability.service.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorOnlineAvailability = sequelize.define(
  "DoctorOnlineAvailability",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
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
  { tableName: "doctor_online_availability", timestamps: false }
);

module.exports = DoctorOnlineAvailability;
