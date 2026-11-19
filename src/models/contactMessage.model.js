/**
 * Maps `contact_messages` — submissions from the public "Contact us" form
 * (frontend-patient /contact). No auth and no FK: a visitor need not have an
 * account. `handled` lets the admin inbox mark a message as followed-up.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ContactMessage = sequelize.define(
  "ContactMessage",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: false },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: false },
    // Captured for spam triage only — never returned to the client.
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    handled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "contact_messages" }
);

module.exports = ContactMessage;
