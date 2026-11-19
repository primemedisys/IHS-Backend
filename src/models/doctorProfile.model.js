/**
 * Maps `doctor_profiles` (docs/dbstruct.md §6). Modeled minimally for auth
 * (/me + profile update) — the richer doctor features (clinics, specializations,
 * availability) get their own models as those features are built.
 *
 * NOTE: `registration_number` is NOT NULL + UNIQUE in the schema, but a doctor
 * doesn't have a verified one at signup. On register we seed a unique
 * placeholder (`PENDING-<userId>`) and leave verificationStatus='pending'; the
 * doctor supplies the real number later via profile update / verification.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorProfile = sequelize.define(
  "DoctorProfile",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    qualification: { type: DataTypes.STRING(255), allowNull: true },
    registrationNumber: { type: DataTypes.STRING(100), allowNull: false },
    experienceYears: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    bio: { type: DataTypes.TEXT, allowNull: true },
    // ── About section extras (migration 049, optional) ───────────────────────
    // A one-to-two sentence introduction (hero + portfolio footer) and a short
    // career overview. The full biography stays in `bio`.
    shortIntro: { type: DataTypes.STRING(500), allowNull: true },
    careerSummary: { type: DataTypes.STRING(2000), allowNull: true },
    // ── Portfolio v2 hero / about / contact (migration 004) ──────────────────
    headline: { type: DataTypes.STRING(160), allowNull: true },
    gender: { type: DataTypes.ENUM("male", "female", "other"), allowNull: true },
    practicePhilosophy: { type: DataTypes.STRING(1000), allowNull: true },
    publicPhone: { type: DataTypes.STRING(20), allowNull: true },
    publicEmail: { type: DataTypes.STRING(190), allowNull: true },
    // Doctor-chosen picture for the "Why Choose <name>" portfolio section
    // (migration 013). NULL → the frontends fall back to the stock image.
    showcaseImageUrl: { type: DataTypes.STRING(512), allowNull: true },
    // Up to three portfolio hero background images, a JSON array of URLs in
    // display order (migration 046). NULL / [] → the plain hero.
    heroImageUrls: { type: DataTypes.JSON, allowNull: true },
    onlineFee: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    verificationStatus: {
      type: DataTypes.ENUM("pending", "approved", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    // Draft vs. submitted-for-review while verificationStatus is still 'pending'
    // (docs/doctor-onboarding/README.md §3). Added by migration 002.
    isSubmitted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // The admin's public-visibility switch (migration 014), INDEPENDENT of
    // verificationStatus: an approved doctor with is_listed=0 keeps their
    // account and existing bookings but disappears from every patient-facing
    // read. Gated in ONE place — doctorService.publicListingWhere.
    isListed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    verificationNotes: { type: DataTypes.STRING(500), allowNull: true },
    avgRating: { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
    ratingCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "doctor_profiles" }
);

module.exports = DoctorProfile;
