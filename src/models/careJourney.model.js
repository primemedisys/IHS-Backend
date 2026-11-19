/**
 * Maps `care_journeys` (migration 011) — one "episode of care" for a patient
 * (e.g. "Back pain, Jul 2026"), grouping every consultation that belongs to the
 * same problem. Created lazily on the first referral off a booking.
 *
 * `patientId` is users.id; `originDoctorId` is doctor_profiles.user_id (== the
 * referring doctor's users.id); `originClinicId` is nullable (NULL = video). The
 * global `underscored: true` maps camelCase attributes to the snake_case columns.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const CareJourney = sequelize.define(
  "CareJourney",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    originDoctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    originClinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    title: { type: DataTypes.STRING(200), allowNull: true },
    status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "care_journeys", timestamps: true }
);

module.exports = CareJourney;
