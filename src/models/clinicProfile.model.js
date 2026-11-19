/**
 * Maps `clinic_profiles` (migration 017) — the account behind the clinic portal.
 *
 * NOT to be confused with `clinic.model.js` / the `clinics` table, which is one
 * DOCTOR'S LOCATION (`clinics.doctor_id` is NOT NULL, ON DELETE CASCADE) and
 * has nothing to sign in as. This is an organisation with its own login.
 *
 * Shaped after DoctorProfile on purpose — PK-is-the-FK, plus the same
 * verificationStatus/isSubmitted pair — so the onboarding checklist and the
 * admin approval queue read identically for both.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ClinicProfile = sequelize.define(
  "ClinicProfile",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    clinicName: { type: DataTypes.STRING(150), allowNull: false },
    registrationNumber: { type: DataTypes.STRING(100), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    addressLine: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(10), allowNull: true },
    // Map location. DECIMAL(10,7) matches clinics.lat/lng so the existing
    // picker component and any future geo query behave identically.
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    logoUrl: { type: DataTypes.STRING(512), allowNull: true },
    about: { type: DataTypes.STRING(1000), allowNull: true },
    verificationStatus: {
      type: DataTypes.ENUM("pending", "approved", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    /** Draft vs. submitted-for-review, while verificationStatus is 'pending'. */
    isSubmitted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    verificationNotes: { type: DataTypes.STRING(500), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "clinic_profiles" }
);

module.exports = ClinicProfile;
