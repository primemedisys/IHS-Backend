/**
 * Maps `video_sessions` (migration 012) — the runtime lifecycle of a video
 * consult (LiveKit). 0/1 per booking (`bookingId` is UNIQUE). Created `pending`
 * when a video booking is paid; driven to `live`/`ended` by LiveKit webhooks.
 *
 * The live call never reads this table — it is audit/attendance/"who's here"
 * only. The global `underscored: true` maps roomName → room_name,
 * doctorJoinedAt → doctor_joined_at, etc.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { VIDEO_SESSION_STATUS } = require("../config/constants");

const VideoSession = sequelize.define(
  "VideoSession",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
    roomName: { type: DataTypes.STRING(120), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(VIDEO_SESSION_STATUS)),
      allowNull: false,
      defaultValue: VIDEO_SESSION_STATUS.PENDING,
    },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    durationSec: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    doctorJoinedAt: { type: DataTypes.DATE, allowNull: true },
    patientJoinedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "video_sessions", timestamps: true }
);

module.exports = VideoSession;
