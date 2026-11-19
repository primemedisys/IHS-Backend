/**
 * Maps `ambulance_booking_events` (migration 040): the booking's status
 * history — the patient timeline AND the audit trail. One row per transition,
 * written inside the transaction that changes the status. Append-only.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const A = require("../config/ambulance");

const AmbulanceBookingEvent = sequelize.define(
  "AmbulanceBookingEvent",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fromStatus: { type: DataTypes.STRING(30), allowNull: true },
    toStatus: { type: DataTypes.STRING(30), allowNull: false },
    actorUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    actorRole: { type: DataTypes.ENUM(...Object.values(A.AMBULANCE_ACTOR)), allowNull: false },
    note: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "ambulance_booking_events",
    timestamps: false,
    indexes: [{ fields: ["booking_id", "created_at"], name: "idx_abe_booking" }],
  }
);

module.exports = AmbulanceBookingEvent;
