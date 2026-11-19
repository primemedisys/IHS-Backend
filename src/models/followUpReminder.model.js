/**
 * The reminder scheduled for a follow-up (docs/follow-up-reminders-07-09-2026).
 *
 * One row per BOOKING — a doctor who tags three consultations gets three
 * independent reminders. The `reminder_at` DATETIME is computed once when the
 * doctor saves: `follow_up_on` at 09:00 IST minus the configured interval.
 *
 * `email_status` and `whatsapp_status` are independent: a WhatsApp failure does
 * not prevent the email from being sent, and vice versa.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const FollowUpReminder = sequelize.define(
  "FollowUpReminder",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    followUpOn: { type: DataTypes.DATEONLY, allowNull: false },
    reminderAt: { type: DataTypes.DATE, allowNull: false },
    channel: {
      type: DataTypes.ENUM("email", "whatsapp", "both"),
      allowNull: false,
      defaultValue: "both",
    },
    status: {
      type: DataTypes.ENUM("pending", "processing", "sent", "failed", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
    },
    emailStatus: {
      type: DataTypes.ENUM("pending", "sent", "failed"),
      allowNull: false,
      defaultValue: "pending",
      field: "email_status",
    },
    whatsappStatus: {
      type: DataTypes.ENUM("pending", "sent", "failed"),
      allowNull: false,
      defaultValue: "pending",
      field: "whatsapp_status",
    },
    retryCount: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      field: "retry_count",
    },
    maxRetries: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 3,
      field: "max_retries",
    },
    lastError: { type: DataTypes.TEXT, allowNull: true, field: "last_error" },
    sentAt: { type: DataTypes.DATE, allowNull: true, field: "sent_at" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { tableName: "follow_up_reminders", timestamps: false }
);

module.exports = FollowUpReminder;
