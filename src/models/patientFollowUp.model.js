/**
 * The follow-up decided AT one consultation (migrations 025 + 026).
 *
 * Keyed on `bookingId` — a follow-up is a decision made at a visit ("seen
 * today, back in four weeks"), not a property of the person. Keying it on the
 * patient (as 025 did) meant changing it on one consultation rewrote it on
 * every appointment that patient had with that doctor, history included.
 *
 * `doctorId` / `patientId` are kept alongside because the roster filters and
 * counts by them, and carrying them saves a join on every list read.
 *
 * `followUpOn` is the date the patient is expected BACK — that is what makes
 * "OPD FU · 4 Sep" actionable on a roster. Nullable, because "SX WAITING with
 * no date yet" is a real state and forcing a date makes doctors invent one.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientFollowUp = sequelize.define(
  "PatientFollowUp",
  {
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    statusId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    followUpOn: { type: DataTypes.DATEONLY, allowNull: true },
    note: { type: DataTypes.STRING(140), allowNull: true },
    // Migration 051 — the EMR follow-up plan. All optional.
    intervalValue: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    intervalUnit: { type: DataTypes.ENUM("day", "week", "month"), allowNull: true },
    homeCare: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    serviceName: { type: DataTypes.STRING(150), allowNull: true },
    serviceQuantity: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    comments: { type: DataTypes.STRING(1000), allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "patient_follow_ups", timestamps: false }
);

module.exports = PatientFollowUp;
