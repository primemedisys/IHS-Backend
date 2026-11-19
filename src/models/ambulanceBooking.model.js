/**
 * Maps `ambulance_bookings` (migration 040): a patient's booking of one
 * ambulance, pickup → destination. The fare inputs (base fare, per-km rate,
 * emergency surcharge) are SNAPSHOTS taken at booking time, so a later price
 * change never rewrites an existing booking. `status` moves only through
 * ambulanceBooking.service (config/ambulance.js AMBULANCE_PROVIDER_TRANSITIONS),
 * and each move writes an ambulance_booking_events row in the same transaction.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const A = require("../config/ambulance");

const num = (field, { allowNull = false, precision = [10, 2], defaultValue } = {}) => ({
  type: DataTypes.DECIMAL(...precision),
  allowNull,
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  get() {
    const v = this.getDataValue(field);
    return v == null ? null : Number(v);
  },
});

const AmbulanceBooking = sequelize.define(
  "AmbulanceBooking",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingCode: { type: DataTypes.STRING(24), allowNull: false, unique: "uq_ab_code" },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    ambulanceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    driverId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    ambulanceType: { type: DataTypes.STRING(40), allowNull: false },
    isEmergency: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    patientName: { type: DataTypes.STRING(150), allowNull: false },
    contactPhone: { type: DataTypes.STRING(20), allowNull: false },
    pickupAddress: { type: DataTypes.STRING(255), allowNull: false },
    pickupLat: num("pickupLat", { precision: [10, 7] }),
    pickupLng: num("pickupLng", { precision: [10, 7] }),
    dropAddress: { type: DataTypes.STRING(255), allowNull: false },
    dropLat: num("dropLat", { precision: [10, 7] }),
    dropLng: num("dropLng", { precision: [10, 7] }),
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    estimatedDistanceKm: num("estimatedDistanceKm", { precision: [8, 2] }),
    baseFare: num("baseFare"),
    perKmRate: num("perKmRate"),
    emergencySurcharge: num("emergencySurcharge", { defaultValue: 0 }),
    waitingChargePerHour: num("waitingChargePerHour", { allowNull: true }),
    estimatedFare: num("estimatedFare"),
    actualDistanceKm: num("actualDistanceKm", { allowNull: true, precision: [8, 2] }),
    waitingMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    finalFare: num("finalFare", { allowNull: true }),
    etaMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(A.AMBULANCE_BOOKING_STATUS)),
      allowNull: false,
      defaultValue: A.AMBULANCE_BOOKING_STATUS.REQUESTED,
    },
    providerNote: { type: DataTypes.STRING(500), allowNull: true },
    cancelReason: { type: DataTypes.STRING(500), allowNull: true },
    cancelledBy: { type: DataTypes.ENUM(...Object.values(A.AMBULANCE_ACTOR)), allowNull: true },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    driverAssignedAt: { type: DataTypes.DATE, allowNull: true },
    enRouteAt: { type: DataTypes.DATE, allowNull: true },
    arrivedAt: { type: DataTypes.DATE, allowNull: true },
    pickedUpAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    rejectedAt: { type: DataTypes.DATE, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "ambulance_bookings",
    timestamps: true,
    indexes: [
      { fields: ["patient_id", "created_at"], name: "idx_ab_patient" },
      { fields: ["provider_id", "status", "created_at"], name: "idx_ab_provider" },
      { fields: ["ambulance_id", "status"], name: "idx_ab_ambulance" },
      { fields: ["driver_id", "status"], name: "idx_ab_driver" },
      { fields: ["status", "created_at"], name: "idx_ab_status" },
    ],
  }
);

module.exports = AmbulanceBooking;
