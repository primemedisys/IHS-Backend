/**
 * Maps `blood_camp_registrations` (migration 039): a patient signing up to
 * donate at a camp. One row per (camp, patient).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodCampRegistration = sequelize.define(
  "BloodCampRegistration",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    campId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    bloodGroup: { type: DataTypes.ENUM(...B.BLOOD_GROUPS), allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(B.CAMP_REGISTRATION_STATUS)), allowNull: false, defaultValue: B.CAMP_REGISTRATION_STATUS.REGISTERED },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_camp_registrations",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["camp_id", "patient_id"], name: "uq_bcr_camp_patient" },
      { fields: ["patient_id"], name: "idx_bcr_patient" },
    ],
  }
);

module.exports = BloodCampRegistration;
