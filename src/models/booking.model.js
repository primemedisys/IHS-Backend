/**
 * Maps `bookings` (docs/dbstruct.md §12) — a patient's appointment with a doctor,
 * either a video consult (clinic_id NULL, booking_type 'online') or an in-clinic
 * visit (booking_type 'offline'). (M:1) to patient/doctor/clinic.
 *
 * NOTE: the DB-generated `active_lock_key` column (the double-booking guard) is
 * DELIBERATELY NOT declared here — it's a STORED generated column the DB
 * maintains. Declaring it would make sequelize.sync() try to create a plain
 * column and clobber the generated one. Since migration 027 it keys on
 * (session_id, queue_number) — "no two patients hold the same token" — rather
 * than on (doctor, date, start time). It's created by the migration (prod) and
 * by db/ensureQueueColumns.js after sync (dev). See docs/consultation-queue.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Booking = sequelize.define(
  "Booking",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    familyMemberId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // NULL = video consult
    /**
     * Who CREATED this booking, when it wasn't the patient (migration 019).
     * NULL = the patient booked it themselves — every row from the direct
     * patient→doctor flow, which this column does not change in any way.
     * Non-NULL = a clinic's users.id, surfaced to the doctor as "booked by
     * X Clinic" and to the patient as "consulted Dr. A via X Clinic".
     */
    bookedByUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    // ── Multi-doctor referrals (migration 011) — nullable denormalized links ────
    journeyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // the care episode this consult belongs to
    referralId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // the referral this consult fulfils, if any
    bookingType: { type: DataTypes.ENUM("online", "offline"), allowNull: false },
    /**
     * ── Consultation queue (migration 027, docs/consultation-queue) ──────────
     *
     * All nullable, so every booking made BEFORE the queue existed is untouched
     * and still renders as the fixed appointment it was.
     */
    sessionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** The patient's token within the session. Immutable once issued. */
    queueNumber: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    queueState: {
      type: DataTypes.ENUM("waiting", "serving", "done", "skipped"),
      allowNull: true,
    },
    calledAt: { type: DataTypes.DATE, allowNull: true },
    consultStartedAt: { type: DataTypes.DATE, allowNull: true },
    consultEndedAt: { type: DataTypes.DATE, allowNull: true },
    slotDate: { type: DataTypes.DATEONLY, allowNull: false },
    /**
     * Under the queue these hold the SESSION'S window — the same pair of values
     * for everyone in that session, not a personal appointment time.
     *
     * Keeping them written is what stopped this feature from touching half the
     * codebase: earnings, the treatment timeline, prescriptions, referrals,
     * clinical notes and the video join-window all read these two fields and
     * needed no change at all.
     */
    slotStartTime: { type: DataTypes.TIME, allowNull: false },
    slotEndTime: { type: DataTypes.TIME, allowNull: false },
    // Set when a DOCTOR moves the appointment (migration 016). Kept as an
    // audit trail so the patient can see the time changed, and why.
    rescheduledAt: { type: DataTypes.DATE, allowNull: true },
    rescheduledReason: { type: DataTypes.STRING(255), allowNull: true },
    status: {
      type: DataTypes.ENUM("pending_payment", "confirmed", "completed", "cancelled", "no_show"),
      allowNull: false,
      defaultValue: "pending_payment",
    },
    paymentMode: { type: DataTypes.ENUM("online", "offline"), allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    meetLink: { type: DataTypes.STRING(500), allowNull: true },
    meetEventId: { type: DataTypes.STRING(255), allowNull: true },
    cancelledReason: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "bookings" }
);

module.exports = Booking;
