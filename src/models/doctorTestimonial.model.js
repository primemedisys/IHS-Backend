/**
 * Maps `doctor_testimonials` (migration 048) — patient feedback that the DOCTOR
 * enters and manages for their public portfolio. Patients do not publish
 * through this table. Only `isVisible` rows are public; the portfolio labels
 * them as shared by the doctor, never as verified reviews. 1:M off
 * doctor_profiles.user_id (as `doctorId`).
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorTestimonial = sequelize.define(
  "DoctorTestimonial",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientName: { type: DataTypes.STRING(120), allowNull: false },
    // Set only after the doctor confirms the patient's consent (doctor.service).
    patientPhotoUrl: { type: DataTypes.STRING(512), allowNull: true },
    reviewText: { type: DataTypes.STRING(1500), allowNull: false },
    rating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    reviewDate: { type: DataTypes.DATEONLY, allowNull: true },
    isVisible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_testimonials", timestamps: true }
);

module.exports = DoctorTestimonial;
