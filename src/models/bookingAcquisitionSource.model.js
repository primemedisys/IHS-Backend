/**
 * Maps `booking_acquisition_sources` (migration 056) — the acquisition answer
 * given on ONE booking (PK booking_id), kept apart from the patient's original
 * discovery source so later bookings never rewrite it.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const BookingAcquisitionSource = sequelize.define(
  "BookingAcquisitionSource",
  {
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    sourceGroup: { type: DataTypes.STRING(30), allowNull: false },
    source: { type: DataTypes.STRING(40), allowNull: false },
    otherText: { type: DataTypes.STRING(120), allowNull: true },
    referralDetails: { type: DataTypes.STRING(160), allowNull: true },
    capturedVia: { type: DataTypes.STRING(20), allowNull: true },
    utm: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "booking_acquisition_sources", timestamps: true, updatedAt: false }
);

module.exports = BookingAcquisitionSource;
