/**
 * Maps `prescription_requests` — a patient uploads a prescription file and
 * shares it with one or more medicine providers (MR / Medicine Store).
 *
 * The provider can then view the prescription and process the request
 * (e.g., confirm availability, prepare the medicines).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { MEDICINE_PROVIDER_TYPE } = require("../config/constants");

const PrescriptionRequest = sequelize.define(
  "PrescriptionRequest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    providerType: {
      type: DataTypes.ENUM(...Object.values(MEDICINE_PROVIDER_TYPE)),
      allowNull: false,
    },
    fileUrl: { type: DataTypes.STRING(512), allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM("pending", "viewed", "processing", "completed", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "prescription_requests",
    timestamps: true,
    indexes: [
      { fields: ["patient_id"], name: "idx_pr_patient" },
      { fields: ["provider_id", "provider_type"], name: "idx_pr_provider" },
      { fields: ["status"], name: "idx_pr_status" },
    ],
  }
);

module.exports = PrescriptionRequest;
