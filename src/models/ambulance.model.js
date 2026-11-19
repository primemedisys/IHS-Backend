/**
 * Maps `ambulances` (migration 040): one vehicle of a provider, with its type,
 * equipment, base location, service radius and pricing.
 *
 * Publicly visible / bookable ONLY when the provider is approved + active AND
 * this row is verification_status='approved', is_active=1 and
 * availability_status='available' — enforced in ambulanceSearch.service, never
 * by the client. `availability_status='on_trip'` is owned by the booking
 * workflow; the provider sets the other values by hand.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const A = require("../config/ambulance");

const decimal = (field) => ({
  type: DataTypes.DECIMAL(10, 2),
  allowNull: false,
  defaultValue: 0,
  get() {
    const v = this.getDataValue(field);
    return v == null ? null : Number(v);
  },
});
const optionalDecimal = (field) => ({
  type: DataTypes.DECIMAL(10, 2),
  allowNull: true,
  get() {
    const v = this.getDataValue(field);
    return v == null ? null : Number(v);
  },
});
const coordinate = (field) => ({
  type: DataTypes.DECIMAL(10, 7),
  allowNull: true,
  get() {
    const v = this.getDataValue(field);
    return v == null ? null : Number(v);
  },
});

const Ambulance = sequelize.define(
  "Ambulance",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    registrationNumber: { type: DataTypes.STRING(30), allowNull: false, unique: "uq_amb_registration" },
    vehicleNumber: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_amb_vehicle" },
    /** A key of config/ambulance.js AMBULANCE_TYPES (VARCHAR, so it stays configurable). */
    ambulanceType: { type: DataTypes.STRING(40), allowNull: false },
    vehicleModel: { type: DataTypes.STRING(100), allowNull: true },
    vehicleDetails: { type: DataTypes.STRING(1000), allowNull: true },
    capacity: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
    /** Keys of AMBULANCE_EQUIPMENT. */
    equipment: { type: DataTypes.JSON, allowNull: true },
    serviceArea: { type: DataTypes.STRING(255), allowNull: true },
    serviceRadiusKm: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    baseAddress: { type: DataTypes.STRING(255), allowNull: true },
    baseCity: { type: DataTypes.STRING(100), allowNull: true },
    baseState: { type: DataTypes.STRING(100), allowNull: true },
    basePincode: { type: DataTypes.STRING(20), allowNull: true },
    baseLat: coordinate("baseLat"),
    baseLng: coordinate("baseLng"),
    isEmergencyAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    baseFare: decimal("baseFare"),
    perKmRate: decimal("perKmRate"),
    waitingChargePerHour: optionalDecimal("waitingChargePerHour"),
    emergencySurcharge: optionalDecimal("emergencySurcharge"),
    defaultDriverId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    availabilityStatus: {
      type: DataTypes.ENUM(...Object.values(A.AMBULANCE_AVAILABILITY)),
      allowNull: false,
      defaultValue: A.AMBULANCE_AVAILABILITY.AVAILABLE,
    },
    verificationStatus: {
      type: DataTypes.ENUM(...Object.values(A.AMBULANCE_VERIFICATION)),
      allowNull: false,
      defaultValue: A.AMBULANCE_VERIFICATION.PENDING,
    },
    verificationNotes: { type: DataTypes.STRING(500), allowNull: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "ambulances",
    timestamps: true,
    indexes: [
      { fields: ["provider_id", "verification_status"], name: "idx_amb_provider" },
      {
        fields: ["verification_status", "is_active", "availability_status", "ambulance_type"],
        name: "idx_amb_public",
      },
      { fields: ["base_lat", "base_lng"], name: "idx_amb_location" },
      { fields: ["base_city", "base_state"], name: "idx_amb_city" },
    ],
  }
);

module.exports = Ambulance;
