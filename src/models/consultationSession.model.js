/**
 * Maps `consultation_sessions` (migration 027, docs/consultation-queue) — one
 * doctor's consulting WINDOW at one place on one day, and the queue that forms
 * inside it.
 *
 * This is what replaced the slot grid: the doctor publishes 9am–4pm at a clinic,
 * patients book the DAY and receive a token, and `next_token` /
 * `current_booking_id` are the two columns the whole queue turns on.
 *
 * NOTE: the DB-generated `clinic_key` column is DELIBERATELY NOT declared here —
 * it is a VIRTUAL generated column the DB maintains (COALESCE(clinic_id, 0)),
 * and declaring it would make sequelize.sync() create a plain column and clobber
 * the generated one. Same discipline as `bookings.active_lock_key`. It is
 * created by the migration (prod) and by db/ensureQueueColumns.js after sync
 * (dev) — see backend-plan §1.6.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { SESSION_STATUS } = require("../config/constants");

const ConsultationSession = sequelize.define(
  "ConsultationSession",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /** NULL = an online/video session — the "virtual clinic". */
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    sessionDate: { type: DataTypes.DATEONLY, allowNull: false },
    startTime: { type: DataTypes.TIME, allowNull: false },
    endTime: { type: DataTypes.TIME, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(SESSION_STATUS)),
      allowNull: false,
      defaultValue: SESSION_STATUS.SCHEDULED,
    },
    /** NULL = unlimited, which is the default and the point of the feature. */
    maxBookings: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    /**
     * The token allocator. Only ever goes UP: a cancelled #4 does not free the
     * number, because a token a patient has been told is theirs must not be
     * handed to somebody else. The QUEUE shrinks instead — position is counted,
     * not stored.
     */
    nextToken: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    /** Who the doctor is with right now; NULL = idle. No FK — see the migration. */
    currentBookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** Measured from finished consults, not configured. Seeds the waiting ETA. */
    avgConsultMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "consultation_sessions" }
);

module.exports = ConsultationSession;
