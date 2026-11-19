/**
 * Availability business logic: per-clinic weekly schedules, the doctor's
 * independent online schedule, and blocked-date exceptions.
 *
 * Weekly schedules are REPLACE-THE-SET resources — the whole week is swapped
 * atomically (destroy-all + bulkCreate in a transaction), mirroring how
 * setSpecializations works, so a schedule can never end up half-saved.
 *
 * A window here is a CONSULTING WINDOW, not a slot generator. Since the
 * consultation-queue migration (027) nothing expands it into discrete start
 * times — `session.service.resolveSession` materialises one session per window
 * per date and patients take a token inside it. What survived that change is
 * `resolveWindows`, which is now load-bearing: every gate (publicly listed,
 * blocked date, clinic ownership) lives there and the queue inherits all three.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  DoctorProfile,
  Clinic,
  ClinicAvailability,
  DoctorOnlineAvailability,
  AvailabilityException,
  Booking,
} = require("../models");
const ApiError = require("../utils/ApiError");
const clinicService = require("./clinic.service");
const doctorService = require("./doctor.service");
const { BOOKING_STATUS, BOOKING_HOLD_MINUTES } = require("../config/constants");

const slotOrder = [
  ["dayOfWeek", "ASC"],
  ["startTime", "ASC"],
];

// ── Clinic weekly schedule ───────────────────────────────────────────────────
async function getClinicAvailability(userId, clinicId) {
  await clinicService.assertClinicOwned(userId, clinicId);
  return ClinicAvailability.findAll({ where: { clinicId }, order: slotOrder });
}

/** Replace a clinic's whole weekly schedule atomically. */
async function setClinicAvailability(userId, clinicId, slots) {
  await clinicService.assertClinicOwned(userId, clinicId);
  await sequelize.transaction(async (tx) => {
    await ClinicAvailability.destroy({ where: { clinicId }, transaction: tx });
    if (slots.length) {
      await ClinicAvailability.bulkCreate(
        slots.map((s) => ({ ...s, clinicId })),
        { transaction: tx }
      );
    }
  });
  return ClinicAvailability.findAll({ where: { clinicId }, order: slotOrder });
}

// ── Online (video) weekly schedule ───────────────────────────────────────────
const getOnlineAvailability = (userId) =>
  DoctorOnlineAvailability.findAll({ where: { doctorId: userId }, order: slotOrder });

/** Replace the doctor's whole online schedule atomically. */
async function setOnlineAvailability(userId, slots) {
  await sequelize.transaction(async (tx) => {
    await DoctorOnlineAvailability.destroy({ where: { doctorId: userId }, transaction: tx });
    if (slots.length) {
      await DoctorOnlineAvailability.bulkCreate(
        slots.map((s) => ({ ...s, doctorId: userId })),
        { transaction: tx }
      );
    }
  });
  return getOnlineAvailability(userId);
}

// ── Exceptions ───────────────────────────────────────────────────────────────
const listExceptions = (userId) =>
  AvailabilityException.findAll({
    where: { doctorId: userId },
    order: [["exceptionDate", "ASC"]],
  });

/** Block a date; if scoped to a clinic, assert the doctor owns that clinic. */
async function addException(userId, { clinicId, exceptionDate, reason }) {
  if (clinicId != null) await clinicService.assertClinicOwned(userId, clinicId);
  return AvailabilityException.create({
    doctorId: userId,
    clinicId: clinicId ?? null,
    exceptionDate,
    reason: reason ?? null,
  });
}

async function removeException(userId, id) {
  const count = await AvailabilityException.destroy({ where: { id, doctorId: userId } });
  if (!count) throw ApiError.notFound("Exception not found");
}

// ── Abandoned holds ──────────────────────────────────────────────────────────
/**
 * Sweep abandoned holds free.
 *
 * A `pending_payment` booking holds its TOKEN via the unique lock key; if the
 * patient never pays we expire it after BOOKING_HOLD_MINUTES. Cancelling nulls
 * the generated key and clears `queue_state`, so the patient drops out of the
 * queue and everyone behind them moves up one on their next poll.
 *
 * Swept on read, one UPDATE, scoped to a single session.
 */
async function expireStaleHolds(sessionId) {
  if (!sessionId) return;
  const cutoff = new Date(Date.now() - BOOKING_HOLD_MINUTES * 60_000);
  await Booking.update(
    { status: BOOKING_STATUS.CANCELLED, cancelledReason: "hold_expired", queueState: null },
    {
      where: {
        sessionId,
        status: BOOKING_STATUS.PENDING,
        createdAt: { [Op.lt]: cutoff },
      },
    }
  );
}

/** "HH:mm:ss"|"HH:mm" → "HH:mm". */
const hhmm = (t) => String(t).slice(0, 5);

/**
 * The raw weekly windows a doctor offers on a date for a mode (clinic|online),
 * after the publicly-listed check, the blocked-date exception, and (clinic mode)
 * the clinic-ownership check. Returns `[]` when the date is blocked or nothing is
 * scheduled.
 *
 * The single gate for the whole queue: `session.service.resolveSession` calls
 * this on the public day list, on booking, and on reschedule, so those three can
 * never drift — which is also why an unlisted doctor can't be booked through a
 * stale or guessed URL.
 */
async function resolveWindows({ doctorId, mode, clinicId, dateStr, dayOfWeek, requireListed = true }) {
  const profile = await DoctorProfile.findByPk(doctorId, {
    attributes: ["userId", ...doctorService.PUBLIC_LISTING_ATTRIBUTES],
  });
  // `requireListed: false` is for DOCTOR-initiated actions on a booking they
  // already own (rescheduling). The listing gate exists to keep patients from
  // reaching a hidden doctor — it must not stop that doctor from managing
  // appointments they already have, which would 404 with "Doctor not found".
  if (requireListed && !doctorService.isPubliclyListed(profile)) {
    throw ApiError.notFound("Doctor not found");
  }
  if (!profile) throw ApiError.notFound("Doctor not found");

  // A matching exception blocks the whole date for this mode/clinic scope.
  const blocked = await AvailabilityException.findOne({
    where: { doctorId, exceptionDate: dateStr, clinicId: mode === "clinic" ? clinicId : null },
    attributes: ["id"],
  });
  if (blocked) return [];

  if (mode === "clinic") {
    const clinic = await Clinic.findOne({
      where: { id: clinicId, doctorId, isActive: true },
      attributes: ["id"],
    });
    if (!clinic) throw ApiError.notFound("Clinic not found");
    const rows = await ClinicAvailability.findAll({ where: { clinicId, dayOfWeek, isActive: true } });
    return rows.map((w) => w.get({ plain: true }));
  }
  const rows = await DoctorOnlineAvailability.findAll({ where: { doctorId, dayOfWeek, isActive: true } });
  return rows.map((w) => w.get({ plain: true }));
}

module.exports = {
  getClinicAvailability,
  setClinicAvailability,
  getOnlineAvailability,
  setOnlineAvailability,
  listExceptions,
  addException,
  removeException,
  expireStaleHolds,
  resolveWindows,
};
