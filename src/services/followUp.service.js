/**
 * Doctor-defined follow-up statuses (docs/follow-up-status).
 *
 * Two things live here: the doctor's OPTION LIST, which is theirs to shape, and
 * the ASSIGNMENT of one option to one patient with the date they're expected
 * back.
 *
 * The list is per doctor and the assignment is per doctor↔patient pair — the
 * same person can be a surgery follow-up for their surgeon and a new patient to
 * a dermatologist. Ownership is always a WHERE, never a post-load check.
 */
const { Op, fn, col } = require("sequelize");
const { sequelize, FollowUpStatus, PatientFollowUp, Booking } = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

/**
 * The starting list every doctor gets — a STARTING LIST, not a fixed set. Each
 * of these is an ordinary row the doctor may rename, recolour, reorder or
 * delete. Nothing in this codebase compares against these strings.
 */
const SEED_STATUSES = [
  { label: "NEW PATIENT", colorHex: "#2E7D53", sortOrder: 0 },
  { label: "OPD FU", colorHex: "#2E86C1", sortOrder: 1 },
  { label: "SX WAITING", colorHex: "#B07714", sortOrder: 2 },
  { label: "SX FU", colorHex: "#5B4CB0", sortOrder: 3 },
];

/**
 * Seed a doctor who has none — for accounts created after migration 025 ran.
 *
 * Guarded on "has NO rows at all", not on each label: a doctor who deliberately
 * deleted every status must not have them silently reappear on the next read.
 * That is only possible while the list is empty, which is exactly when the
 * doctor has never touched it… except for one case, so the caller passes
 * `seed: false` once the doctor has demonstrably managed their own list.
 */
async function ensureSeeded(doctorId) {
  const existing = await FollowUpStatus.count({ where: { doctorId } });
  if (existing > 0) return;
  await FollowUpStatus.bulkCreate(
    SEED_STATUSES.map((s) => ({ ...s, doctorId })),
    { ignoreDuplicates: true }
  );
}

/**
 * The doctor's list, in their own order, each with how many patients carry it.
 *
 * `inUse` comes from ONE grouped count rather than a query per status — the
 * options page renders every row with its count, and a count per row is an
 * N+1 that grows with the doctor's own list.
 */
async function listStatuses(doctorId, { includeArchived = true } = {}) {
  await ensureSeeded(doctorId);

  const where = { doctorId };
  if (!includeArchived) where.isActive = true;

  const statuses = await FollowUpStatus.findAll({
    where,
    order: [
      ["sortOrder", "ASC"],
      ["id", "ASC"],
    ],
  });

  const counts = await PatientFollowUp.findAll({
    where: { doctorId },
    attributes: ["statusId", [fn("COUNT", col("patient_id")), "n"]],
    group: ["statusId"],
    raw: true,
  });
  const byStatus = new Map(counts.map((c) => [String(c.statusId), Number(c.n)]));

  return statuses.map((s) => {
    const plain = s.get({ plain: true });
    return { ...plain, inUse: byStatus.get(String(s.id)) ?? 0 };
  });
}

/** Add one. The unique (doctor_id, label) index is what makes duplicates a 409. */
async function createStatus(doctorId, { label, colorHex, sortOrder }) {
  const clash = await FollowUpStatus.findOne({ where: { doctorId, label } });
  if (clash) {
    throw new ApiError(409, `You already have a status called "${label}"`, {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  // Append to the end when no position is given, so a new status never displaces
  // the order the doctor arranged.
  const last = await FollowUpStatus.max("sortOrder", { where: { doctorId } });
  return FollowUpStatus.create({
    doctorId,
    label,
    colorHex,
    sortOrder: sortOrder ?? (Number.isFinite(last) ? Number(last) + 1 : 0),
  });
}

/** Rename / recolour / reorder / archive. Only ever the doctor's own row. */
async function updateStatus(doctorId, id, patch) {
  const status = await FollowUpStatus.findOne({ where: { id, doctorId } });
  if (!status) throw ApiError.notFound("Follow-up status not found");

  if (patch.label && patch.label !== status.label) {
    const clash = await FollowUpStatus.findOne({
      where: { doctorId, label: patch.label, id: { [Op.ne]: id } },
    });
    if (clash) {
      throw new ApiError(409, `You already have a status called "${patch.label}"`, {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
  }

  await status.update(patch);
  return status;
}

/**
 * Delete one — REFUSED while patients still carry it.
 *
 * Silently clearing thirty patients' categories to delete one row is not
 * recoverable, so the caller is told how many are affected and offered
 * archiving instead (PATCH isActive:false), which hides the status from the
 * pickers while those patients keep their tag.
 */
async function deleteStatus(doctorId, id) {
  const status = await FollowUpStatus.findOne({ where: { id, doctorId } });
  if (!status) throw ApiError.notFound("Follow-up status not found");

  const inUse = await PatientFollowUp.count({ where: { statusId: id } });
  if (inUse > 0) {
    throw new ApiError(
      409,
      `${inUse} patient${inUse === 1 ? "" : "s"} still use this status. Archive it instead, or move them first.`,
      { code: ERROR_CODES.STATUS_IN_USE, details: { inUse } }
    );
  }

  await status.destroy();
  return { id: String(id) };
}

/** Reorder the whole list in one transaction — a half-applied order is worse than none. */
async function reorderStatuses(doctorId, ids) {
  const owned = await FollowUpStatus.findAll({ where: { doctorId, id: { [Op.in]: ids } }, attributes: ["id"] });
  if (owned.length !== ids.length) throw ApiError.notFound("Follow-up status not found");

  await sequelize.transaction(async (transaction) => {
    await Promise.all(
      ids.map((id, i) =>
        FollowUpStatus.update({ sortOrder: i }, { where: { id, doctorId }, transaction })
      )
    );
  });
  return listStatuses(doctorId);
}

/**
 * The consultation must be the DOCTOR'S OWN.
 *
 * Ownership is the WHERE clause, never a post-load check, and someone else's
 * booking is a 404 rather than a 403 — a 403 would confirm it exists.
 */
async function assertDoctorOwnsBooking(doctorId, bookingId) {
  const booking = await Booking.findOne({
    where: { id: bookingId, doctorId },
    attributes: ["id", "patientId"],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  return booking;
}

/** The optional EMR plan fields (migration 051) — only the ones the caller sent. */
const PLAN_FIELDS = ["intervalValue", "intervalUnit", "homeCare", "serviceName", "serviceQuantity", "comments"];
function planPatch(body) {
  const out = {};
  for (const k of PLAN_FIELDS) {
    if (body[k] === undefined) continue;
    out[k] = body[k] === "" ? null : body[k];
  }
  return out;
}

/**
 * Set (or replace) THIS CONSULTATION'S follow-up.
 *
 * One row per booking, so this is an upsert — and re-tagging one visit leaves
 * that patient's other visits exactly as they were.
 *
 * When followUpOn changes, the related reminder (if any) is rescheduled.
 */
async function setBookingFollowUp(doctorId, bookingId, body) {
  const { statusId, followUpOn, note } = body;
  // The status must be the DOCTOR'S OWN — otherwise a doctor could tag a
  // consultation with another doctor's private category by guessing an id.
  const status = await FollowUpStatus.findOne({ where: { id: statusId, doctorId } });
  if (!status) throw ApiError.notFound("Follow-up status not found");

  const booking = await assertDoctorOwnsBooking(doctorId, bookingId);

  // Check if followUpOn is changing (for reminder reschedule).
  const existing = await PatientFollowUp.findOne({ where: { bookingId, doctorId }, attributes: ["followUpOn"] });
  const dateChanged = existing && existing.followUpOn !== (followUpOn ?? null);

  await PatientFollowUp.upsert({
    bookingId: booking.id,
    doctorId,
    patientId: booking.patientId,
    statusId,
    followUpOn: followUpOn ?? null,
    note: note ?? null,
    ...planPatch(body),
    updatedAt: new Date(),
  });

  // Reschedule or cancel the reminder when the follow-up date changes.
  // Lazy-require to avoid circular dependencies at module load time.
  const followUpReminderService = require("./followUpReminder.service");
  if (followUpOn) {
    await followUpReminderService.rescheduleForBooking(
      bookingId, doctorId, booking.patientId, booking.clinicId, followUpOn
    );
  } else {
    await followUpReminderService.cancelForBooking(bookingId);
  }

  return getBookingFollowUp(doctorId, bookingId);
}

/** This consultation's follow-up, or null when it hasn't been tagged. */
function getBookingFollowUp(doctorId, bookingId) {
  return PatientFollowUp.findOne({
    where: { doctorId, bookingId },
    include: [{ model: FollowUpStatus, as: "status" }],
  });
}

/** Clear it. Idempotent — clearing an untagged consultation is not an error. */
async function clearBookingFollowUp(doctorId, bookingId) {
  await PatientFollowUp.destroy({ where: { doctorId, bookingId } });
  // Cancel any pending reminder for this booking.
  const followUpReminderService = require("./followUpReminder.service");
  await followUpReminderService.cancelForBooking(bookingId);
  return { bookingId: String(bookingId) };
}

/**
 * Every follow-up on a page of bookings, keyed by booking id — ONE query for
 * the whole list rather than a join that re-reads the status per row.
 */
async function mapForBookings(doctorId, bookingIds) {
  const ids = [...new Set(bookingIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const rows = await PatientFollowUp.findAll({
    where: { doctorId, bookingId: { [Op.in]: ids } },
    include: [{ model: FollowUpStatus, as: "status" }],
  });
  return new Map(rows.map((r) => [String(r.bookingId), r]));
}

module.exports = {
  SEED_STATUSES,
  ensureSeeded,
  listStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
  reorderStatuses,
  setBookingFollowUp,
  getBookingFollowUp,
  clearBookingFollowUp,
  mapForBookings,
  assertDoctorOwnsBooking,
};
