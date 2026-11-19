/**
 * Maps `medicine_notifications` — in-app notifications related to medicine
 * orders, stock alerts, or other medicine-module events for a user.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MedicineNotification = sequelize.define(
  "MedicineNotification",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.STRING(50), allowNull: false },
    referenceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    referenceType: { type: DataTypes.STRING(50), allowNull: true },
    isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "medicine_notifications", timestamps: false }
);

module.exports = MedicineNotification;
