/**
 * Maps `patient_profiles` (docs/dbstruct.md §2). Modeled minimally for auth
 * (/me + profile update). Every column is nullable, so a bare row can be
 * created at signup and filled in later from the patient dashboard.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PatientProfile = sequelize.define(
  "PatientProfile",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
    gender: { type: DataTypes.ENUM("male", "female", "other"), allowNull: true },
    bloodGroup: {
      type: DataTypes.ENUM("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"),
      allowNull: true,
      defaultValue: "unknown",
    },
    emergencyContactName: { type: DataTypes.STRING(150), allowNull: true },
    emergencyContactPhone: { type: DataTypes.STRING(20), allowNull: true },
    addressLine: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    // "No known allergies/conditions" acknowledgements — let a genuinely-clear
    // patient reach 100% completion without an empty list reading as "unfilled".
    noKnownAllergies: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    noKnownConditions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /**
     * "I take nothing" — an ANSWER, distinct from an empty medication list,
     * which only means nobody has asked yet (migration 020).
     */
    noCurrentMedications: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // ── WhatsApp consent (docs/follow-up-reminders-07-09-2026) ──────────────
    whatsappOptIn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "whatsapp_opt_in" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "patient_profiles" }
);

module.exports = PatientProfile;
