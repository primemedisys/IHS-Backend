/**
 * Automatic follow-up reminder CRUD (docs/follow-up-reminders-07-09-2026).
 *
 * One reminder per BOOKING. The doctor configures timing and channels from the
 * existing FollowUpPanel. The scheduler (reminderScheduler.service.js) picks
 * up due reminders and dispatches them.
 *
 * `reminder_at` is computed as: follow_up_on at 09:00 IST minus the interval.
 * IST is a fixed +05:30 offset (no DST), so this is deterministic.
 */
const { Op } = require("sequelize");
const { sequelize, FollowUpReminder, Booking, User, Clinic, PatientProfile, DoctorProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { REMINDER_STATUS, DEFAULT_REMINDER_DAYS_BEFORE } = require("../config/constants");

// ── IST helpers ─────────────────────────────────────────────────────────────
/** 09:00 IST in UTC = 03:30 UTC. */
const IST_TRIGGER_HOUR_UTC = 3;
const IST_TRIGGER_MINUTE_UTC = 30;

/**
 * Compute `reminder_at` (UTC DATETIME) from a follow-up DATE and an interval.
 * The trigger fires at 09:00 IST on (followUpOn - daysBefore).
 */
function computeReminderAt(followUpOn, daysBefore) {
  // Parse the DATEONLY as a local date (not UTC-parsed).
  const [y, m, d] = String(followUpOn).slice(0, 10).split("-").map(Number);
  const target = new Date(y, m - 1, d);
  target.setDate(target.getDate() - daysBefore);
  target.setUTCHours(IST_TRIGGER_HOUR_UTC, IST_TRIGGER_MINUTE_UTC, 0, 0);
  return target;
}

/**
 * Determine which channels are actually deliverable for a patient.
 * Returns the effective channel given the patient's data and consent.
 */
function resolveEffectiveChannel(channel, patient, patientProfile) {
  const hasEmail = Boolean(patient?.email);
  const hasPhone = Boolean(patient?.phone);
  const whatsappAllowed = Boolean(patientProfile?.whatsappOptIn);

  if (channel === "email") return hasEmail ? "email" : null;
  if (channel === "whatsapp") return hasPhone && whatsappAllowed ? "whatsapp" : null;

  // "both" — include whichever are available
  const channels = [];
  if (hasEmail) channels.push("email");
  if (hasPhone && whatsappAllowed) channels.push("whatsapp");
  if (channels.length === 0) return null;
  if (channels.length === 1) return channels[0];
  return "both";
}

// ── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create or update the reminder for a booking.
 *
 * Called from the FollowUpPanel when the doctor saves a reminder config.
 * If `followUpOn` is null (no follow-up date), this is a no-op — a reminder
 * without a follow-up date is meaningless.
 */
async function setReminder(doctorId, bookingId, { reminderDaysBefore, reminderAt, channel }) {
  // The booking must be the doctor's own.
  const booking = await Booking.findOne({
    where: { id: bookingId, doctorId },
    attributes: ["id", "patientId", "clinicId"],
  });
  if (!booking) throw ApiError.notFound("Booking not found");

  // Load the existing follow-up to get followUpOn.
  const { PatientFollowUp } = require("../models");
  const followUp = await PatientFollowUp.findOne({
    where: { bookingId, doctorId },
    attributes: ["followUpOn"],
  });
  if (!followUp || !followUp.followUpOn) {
    throw new ApiError(422, "Set a follow-up date before configuring a reminder", {
      code: "VALIDATION_ERROR",
    });
  }

  const followUpOn = followUp.followUpOn;

  // Compute reminder_at
  let computedAt;
  if (reminderAt) {
    computedAt = new Date(reminderAt);
  } else {
    const days = reminderDaysBefore ?? DEFAULT_REMINDER_DAYS_BEFORE;
    computedAt = computeReminderAt(followUpOn, days);
  }

  // Determine effective channel based on patient data and consent.
  const patient = await User.findByPk(booking.patientId, {
    attributes: ["id", "email", "phone"],
  });
  const patientProfile = await PatientProfile.findByPk(booking.patientId, {
    attributes: ["whatsappOptIn"],
  });
  const effectiveChannel = resolveEffectiveChannel(channel || "both", patient, patientProfile);
  if (!effectiveChannel) {
    throw new ApiError(422, "Patient has no email or phone with WhatsApp consent", {
      code: "VALIDATION_ERROR",
    });
  }

  // Upsert (one reminder per booking).
  const [row, created] = await FollowUpReminder.findOrCreate({
    where: { bookingId },
    defaults: {
      bookingId,
      doctorId,
      patientId: booking.patientId,
      clinicId: booking.clinicId,
      followUpOn,
      reminderAt: computedAt,
      channel: effectiveChannel,
      status: REMINDER_STATUS.PENDING,
      emailStatus: effectiveChannel === "whatsapp" ? "pending" : "pending",
      whatsappStatus: effectiveChannel === "email" ? "pending" : "pending",
    },
  });

  if (!created) {
    // Recompute channel if patient consent may have changed.
    await row.update({
      followUpOn,
      reminderAt: computedAt,
      channel: effectiveChannel,
      status: REMINDER_STATUS.PENDING,
      emailStatus: "pending",
      whatsappStatus: "pending",
      retryCount: 0,
      lastError: null,
      sentAt: null,
    });
  }

  return row;
}

/** Get the reminder for a specific booking. */
async function getReminder(doctorId, bookingId) {
  const row = await FollowUpReminder.findOne({
    where: { bookingId, doctorId },
    include: [
      { model: Booking, as: "booking", attributes: ["id"] },
    ],
  });
  return row || null;
}

/** Cancel the reminder for a booking. */
async function cancelReminder(doctorId, bookingId) {
  const row = await FollowUpReminder.findOne({ where: { bookingId, doctorId } });
  if (!row) return { bookingId: String(bookingId) };
  if (row.status === REMINDER_STATUS.SENT) {
    return { bookingId: String(bookingId), note: "Already sent" };
  }
  await row.update({ status: REMINDER_STATUS.CANCELLED });
  return { bookingId: String(bookingId) };
}

/** Cancel reminders for a booking (internal, no doctor auth needed). */
async function cancelForBooking(bookingId) {
  const row = await FollowUpReminder.findOne({ where: { bookingId } });
  if (!row) return;
  if (row.status === REMINDER_STATUS.SENT || row.status === REMINDER_STATUS.CANCELLED) return;
  await row.update({ status: REMINDER_STATUS.CANCELLED });
}

/**
 * Reschedule the reminder when follow_up_on changes.
 * Recomputes reminder_at and resets delivery status.
 */
async function rescheduleForBooking(bookingId, doctorId, patientId, clinicId, followUpOn) {
  const row = await FollowUpReminder.findOne({ where: { bookingId } });
  if (!row) return;

  const patient = await User.findByPk(patientId, { attributes: ["id", "email", "phone"] });
  const patientProfile = await PatientProfile.findByPk(patientId, { attributes: ["whatsappOptIn"] });
  const effectiveChannel = resolveEffectiveChannel(row.channel, patient, patientProfile);

  if (!effectiveChannel) {
    // Patient lost all channels — cancel the reminder.
    await row.update({ status: REMINDER_STATUS.CANCELLED });
    return;
  }

  const computedAt = computeReminderAt(followUpOn, DEFAULT_REMINDER_DAYS_BEFORE);
  await row.update({
    followUpOn,
    reminderAt: computedAt,
    clinicId,
    channel: effectiveChannel,
    status: REMINDER_STATUS.PENDING,
    emailStatus: "pending",
    whatsappStatus: "pending",
    retryCount: 0,
    lastError: null,
    sentAt: null,
  });
}

/**
 * List upcoming follow-ups for a patient (patient dashboard).
 * Returns follow-up reminders where follow_up_on >= today.
 */
async function listUpcomingForPatient(patientId) {
  const today = new Date().toISOString().slice(0, 10);
  return FollowUpReminder.findAll({
    where: {
      patientId,
      followUpOn: { [Op.gte]: today },
      status: { [Op.in]: [REMINDER_STATUS.PENDING, REMINDER_STATUS.SENT] },
    },
    include: [
      {
        model: Booking,
        as: "booking",
        attributes: ["id", "slotDate", "bookingType"],
        include: [
          {
            model: DoctorProfile,
            as: "doctor",
            attributes: ["userId"],
            include: [{ model: User, as: "user", attributes: ["id", "name"] }],
          },
          { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
        ],
      },
    ],
    order: [["followUpOn", "ASC"]],
  });
}

module.exports = {
  computeReminderAt,
  resolveEffectiveChannel,
  setReminder,
  getReminder,
  cancelReminder,
  cancelForBooking,
  rescheduleForBooking,
  listUpcomingForPatient,
};
