/**
 * Maps `blood_camps` (migration 039): a donation camp a blood bank organises.
 * Patients can see upcoming camps and register (blood_camp_registrations).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const B = require("../config/bloodBank");

const BloodCamp = sequelize.define(
  "BloodCamp",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bloodBankId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    campDate: { type: DataTypes.DATEONLY, allowNull: false },
    startTime: { type: DataTypes.TIME, allowNull: false },
    endTime: { type: DataTypes.TIME, allowNull: false },
    venue: { type: DataTypes.STRING(255), allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    organizer: { type: DataTypes.STRING(150), allowNull: true },
    contactPhone: { type: DataTypes.STRING(20), allowNull: true },
    description: { type: DataTypes.STRING(1000), allowNull: true },
    capacity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(B.CAMP_STATUS)), allowNull: false, defaultValue: B.CAMP_STATUS.SCHEDULED },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "blood_camps",
    timestamps: true,
    indexes: [
      { fields: ["blood_bank_id", "camp_date"], name: "idx_bc_bank" },
      { fields: ["camp_date", "status"], name: "idx_bc_date" },
    ],
  }
);

module.exports = BloodCamp;
