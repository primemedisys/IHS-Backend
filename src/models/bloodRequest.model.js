/**
 * Maps `blood_requests` (migration 039): a patient asks ONE blood bank for N
 * units of one blood group + component. Emergency is a flag (`isEmergency`) so
 * an emergency request moves through the same lifecycle and is surfaced first.
 * `referredByDoctorId` is the extension point for doctor referrals. The
 * supporting document is stored through the existing storage driver and only
 * ever STREAMED (documentUrl never leaves the server).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodRequest = sequelize.define(
  "BloodRequest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    requestCode: { type: DataTypes.STRING(20), allowNull: false, unique: "uq_brq_code" },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    referredByDoctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    bloodGroup: { type: DataTypes.ENUM(...B.BLOOD_GROUPS), allowNull: false },
    component: { type: DataTypes.STRING(30), allowNull: false },
    unitsRequired: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    urgency: { type: DataTypes.ENUM(...Object.values(B.BLOOD_URGENCY)), allowNull: false, defaultValue: B.BLOOD_URGENCY.ROUTINE },
    isEmergency: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requiredBy: { type: DataTypes.DATE, allowNull: true },
    patientName: { type: DataTypes.STRING(150), allowNull: false },
    hospitalName: { type: DataTypes.STRING(200), allowNull: false },
    hospitalAddress: { type: DataTypes.STRING(255), allowNull: true },
    doctorName: { type: DataTypes.STRING(150), allowNull: true },
    contactName: { type: DataTypes.STRING(150), allowNull: false },
    contactPhone: { type: DataTypes.STRING(20), allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    documentUrl: { type: DataTypes.STRING(512), allowNull: true },
    documentName: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(B.BLOOD_REQUEST_STATUS)), allowNull: false, defaultValue: B.BLOOD_REQUEST_STATUS.PENDING },
    bankNote: { type: DataTypes.STRING(500), allowNull: true },
    approvedByName: { type: DataTypes.STRING(150), allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_requests",
    timestamps: true,
    indexes: [
      { fields: ["patient_id", "created_at"], name: "idx_brq_patient" },
      { fields: ["blood_bank_id", "status", "is_emergency"], name: "idx_brq_bank" },
    ],
  }
);

module.exports = BloodRequest;
