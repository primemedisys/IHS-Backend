/**
 * Maps `doctor_gallery` (docs/dbstruct.md §6k) — clinic / practice photos. 1:M
 * off doctor_profiles.user_id. `imageUrl` comes from upload.service.put().
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorGallery = sequelize.define(
  "DoctorGallery",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    imageUrl: { type: DataTypes.STRING(500), allowNull: false },
    // ── Migration 049 metadata (all optional) ──
    title: { type: DataTypes.STRING(150), allowNull: true },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    // One of GALLERY_CATEGORIES (config/constants) — validated by Joi.
    category: { type: DataTypes.STRING(30), allowNull: true },
    altText: { type: DataTypes.STRING(255), allowNull: true },
    takenOn: { type: DataTypes.DATEONLY, allowNull: true },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_gallery", timestamps: false }
);

module.exports = DoctorGallery;
