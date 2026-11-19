/**
 * Maps `doctor_faqs` (docs/dbstruct.md §6l) — common patient questions the
 * doctor answers on their profile. 1:M off doctor_profiles.user_id.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorFaq = sequelize.define(
  "DoctorFaq",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    question: { type: DataTypes.STRING(300), allowNull: false },
    answer: { type: DataTypes.STRING(1000), allowNull: false },
    displayOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  },
  { tableName: "doctor_faqs", timestamps: false }
);

module.exports = DoctorFaq;
