/**
 * One option on a doctor's follow-up list (migration 025).
 *
 * The list is the DOCTOR'S: they add, rename, recolour, reorder and delete
 * these rows. The four seeded at migration time ("NEW PATIENT", "OPD FU",
 * "SX WAITING", "SX FU") are a starting point, nothing more — no code may
 * branch on a label's text, because any of them may be renamed to anything.
 *
 * `isActive` is how a status in USE gets retired: deleting one that patients
 * still carry is refused (see followUp.service), so archiving hides it from
 * the pickers while those patients keep their tag.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const FollowUpStatus = sequelize.define(
  "FollowUpStatus",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    label: { type: DataTypes.STRING(40), allowNull: false },
    /** "#RRGGBB". Validated by Joi on the way in; stored verbatim. */
    colorHex: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#2E86C1" },
    sortOrder: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "follow_up_statuses",
    timestamps: true,
    indexes: [{ unique: true, fields: ["doctor_id", "label"] }],
  }
);

module.exports = FollowUpStatus;
