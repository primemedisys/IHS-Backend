/**
 * Patient medicine routines, dose tracking and prescription sync
 * (migration 055, docs/medicine-management-31-10-2026).
 *
 * Rules everything here follows:
 *  - OWNERSHIP IS THE WHERE CLAUSE. Every read and write is keyed on the
 *    signed-in patient's id (`req.user.id`); a patient id is never read from
 *    the request body, so one patient can never reach another's routines.
 *  - THE DOCTOR'S LINE IS NEVER REWRITTEN. A routine copied from a finalized
 *    prescription keeps `prescribedSnapshot` untouched and locks the prescribed
 *    fields; the patient may change only their own reminder preferences.
 *  - A DOSE IS "TAKEN" ONLY WHEN THE PATIENT SAYS SO. Delivering a reminder
 *    never changes a dose's status; the missed sweep only marks doses that
 *    stayed open past the grace period.
 *  - BOUNDED GENERATION. Dose rows exist for a rolling window
 *    (DOSE_WINDOW_DAYS) and are UNIQUE per (routine, slot), so regenerating is
 *    always safe and never duplicates a dose.
 */
const { Op, UniqueConstraintError } = require("sequelize");
const {
  sequelize,
  PatientMedicine,
  MedicineDoseLog,
  MedicineDoseEvent,
  PatientMedicineSettings,
  MedicineNotification,
  MedicineMaster,
  Medicine,
  Prescription,
  PrescriptionItem,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const realtime = require("../realtime/socket");
const sched = require("../utils/medicineSchedule");
const { serializeDose } = require("../utils/patientMedicineSerializers");
const {
  ERROR_CODES,
  PRESCRIPTION_STATUS,
  PATIENT_MEDICINE_SOURCES: SRC,
  PATIENT_MEDICINE_STATUS: ST,
  PATIENT_MEDICINE_STATUS_REASONS: REASON,
  DOSE_STATUS: DS,
  DOSE_ACTIONS,
  DOSE_MISSED_AFTER_MINUTES,
  DOSE_WINDOW_DAYS,
  DEFAULT_PATIENT_TIMEZONE,
  NOTIFICATION_TYPES: T,
  NOTIFICATION_REFS,
} = require("../config/constants");

/** Socket event telling the patient's other open apps that a dose changed. */
const DOSE_UPDATED_EVENT = "medicine_dose_updated";
/** Socket event telling the patient's apps that their routines changed (re-fetch + reschedule). */
const ROUTINES_CHANGED_EVENT = "medicine_routines_changed";

const MINUTE = 60 * 1000;
/** A dose can be acted on from this long before its slot (taking an evening dose early). */
const ACT_AHEAD_MS = 12 * 60 * MINUTE;
const MAX_SNOOZES = 12;

const OPEN_DOSE = [DS.PENDING, DS.SNOOZED];
const LIVE_ROUTINE = [ST.ACTIVE, ST.PAUSED];

/** Fields of a prescribed routine that only the doctor's prescription may set. */
const PRESCRIBED_LOCKED = [
  "medicineName",
  "genericName",
  "strength",
  "dosageForm",
  "dose",
  "frequency",
  "foodTiming",
  "durationDays",
  "instructions",
  "medicineMasterId",
];
/** Changing any of these regenerates the routine's future dose rows. */
const SCHEDULE_FIELDS = ["reminderTimes", "daysOfWeek", "startDate", "durationDays", "timezone"];

const likeOf = (q) => `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const routineInclude = [
  { model: User, as: "prescriber", attributes: ["id", "name"] },
  { model: Prescription, as: "prescription", attributes: ["id", "rxNumber", "finalizedAt", "status"] },
];
const doseInclude = [
  {
    model: PatientMedicine,
    as: "medicine",
    attributes: [
      "id",
      "source",
      "medicineName",
      "strength",
      "dosageForm",
      "dose",
      "foodTiming",
      "instructions",
      "status",
      "reminderEnabled",
      "timezone",
    ],
  },
];

function notifyRoutinesChanged(patientId, transaction) {
  const send = () => realtime.emitToUser(patientId, ROUTINES_CHANGED_EVENT, { at: new Date().toISOString() });
  if (transaction) transaction.afterCommit(send);
  else send();
}

// ── Settings ────────────────────────────────────────────────────────────────
async function getSettings(patientId, { transaction } = {}) {
  const [row] = await PatientMedicineSettings.findOrCreate({
    where: { patientId },
    defaults: { patientId, timezone: DEFAULT_PATIENT_TIMEZONE },
    transaction,
  });
  return row;
}

async function updateSettings(patientId, dto) {
  const row = await getSettings(patientId);
  const tzChanged = dto.timezone && dto.timezone !== row.timezone;
  await sequelize.transaction(async (transaction) => {
    await row.update(dto, { transaction });
    if (tzChanged) {
      // Reminder times are wall-clock times: moving zones keeps "08:00" at 08:00
      // local, so every live routine's future slots are rebuilt in the new zone.
      const routines = await PatientMedicine.findAll({
        where: { patientId, status: { [Op.in]: LIVE_ROUTINE } },
        transaction,
      });
      if (routines.length) {
        await PatientMedicine.update(
          { timezone: dto.timezone },
          { where: { id: { [Op.in]: routines.map((r) => r.id) } }, transaction }
        );
        for (const r of routines) r.timezone = dto.timezone;
        await rescheduleFuture(
          routines.filter((r) => r.status === ST.ACTIVE),
          { transaction, clearIds: routines.map((r) => r.id) }
        );
      }
    }
    notifyRoutinesChanged(patientId, transaction);
  });
  return row;
}

// ── Dose generation ─────────────────────────────────────────────────────────
/**
 * Insert any missing dose rows for `routines` from today (local) through the
 * window. Past slots are never back-filled (a routine created at 3 pm does not
 * invent a missed 8 am dose). Idempotent via the UNIQUE (routine, slot) key.
 */
async function generateDoses(routines, { transaction, now = new Date() } = {}) {
  const rows = [];
  for (const r of routines) {
    if (r.status !== ST.ACTIVE) continue;
    const tz = sched.isValidTimeZone(r.timezone) ? r.timezone : DEFAULT_PATIENT_TIMEZONE;
    const today = sched.localDate(now, tz);
    const until = sched.addDays(today, DOSE_WINDOW_DAYS);
    for (const o of sched.occurrencesFor(r, today, until)) {
      if (o.scheduledAt.getTime() < now.getTime() - MINUTE) continue;
      rows.push({
        patientMedicineId: r.id,
        patientId: r.patientId,
        scheduledDate: o.scheduledDate,
        scheduledTime: o.scheduledTime,
        scheduledAt: o.scheduledAt,
        dueAt: o.scheduledAt,
        status: DS.PENDING,
      });
    }
  }
  if (rows.length) await MedicineDoseLog.bulkCreate(rows, { ignoreDuplicates: true, transaction });
  return rows.length;
}

/** Remove the routines' future, un-actioned doses (a schedule change / pause / stop). */
async function clearFutureDoses(routineIds, { transaction, now = new Date() } = {}) {
  if (!routineIds.length) return 0;
  return MedicineDoseLog.destroy({
    where: {
      patientMedicineId: { [Op.in]: routineIds },
      status: { [Op.in]: OPEN_DOSE },
      scheduledAt: { [Op.gt]: now },
    },
    transaction,
  });
}

async function rescheduleFuture(routines, { transaction, clearIds } = {}) {
  await clearFutureDoses(clearIds ?? routines.map((r) => r.id), { transaction });
  await generateDoses(routines, { transaction });
}

/** Top up the window for one patient's active routines (cheap; called on reads). */
async function topUpForPatient(patientId) {
  const routines = await PatientMedicine.findAll({
    where: { patientId, status: ST.ACTIVE },
    attributes: ["id", "patientId", "status", "reminderTimes", "daysOfWeek", "timezone", "startDate", "endDate"],
  });
  await generateDoses(routines);
}

/**
 * Mark doses that stayed open past the grace period as missed — for one
 * patient (on read) or everyone (the sweep). Each change gets an audit event.
 */
async function markMissed({ patientId, now = new Date(), limit = 500 } = {}) {
  const cutoff = new Date(now.getTime() - DOSE_MISSED_AFTER_MINUTES * MINUTE);
  const where = { status: { [Op.in]: OPEN_DOSE }, dueAt: { [Op.lt]: cutoff } };
  if (patientId) where.patientId = patientId;
  const stale = await MedicineDoseLog.findAll({ where, attributes: ["id", "patientId"], limit });
  if (!stale.length) return 0;
  await sequelize.transaction(async (transaction) => {
    const [count] = await MedicineDoseLog.update(
      { status: DS.MISSED },
      { where: { id: { [Op.in]: stale.map((d) => d.id) }, status: { [Op.in]: OPEN_DOSE } }, transaction }
    );
    if (count) {
      await MedicineDoseEvent.bulkCreate(
        stale.map((d) => ({ doseLogId: d.id, patientId: d.patientId, action: DS.MISSED, actedAt: now, source: "system" })),
        { transaction }
      );
    }
  });
  return stale.length;
}

// ── Catalogue search (patients) ─────────────────────────────────────────────
/** Active catalogue medicines matching every word of `q` (name / generic / strength). */
async function searchCatalogue(q) {
  const words = String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  return MedicineMaster.findAll({
    where: {
      isActive: true,
      [Op.and]: words.map((w) => ({
        [Op.or]: ["medicineName", "genericName", "strength"].map((f) => ({ [f]: { [Op.like]: likeOf(w) } })),
      })),
    },
    attributes: ["id", "medicineName", "genericName", "medicineType", "strength", "manufacturer"],
    order: [["medicineName", "ASC"]],
    limit: 20,
  });
}

// ── Routines: read ──────────────────────────────────────────────────────────
async function list(patientId, { status, source } = {}) {
  const where = { patientId };
  if (status) where.status = status;
  if (source) where.source = source;
  return PatientMedicine.findAll({
    where,
    include: routineInclude,
    order: [
      [sequelize.literal("FIELD(`PatientMedicine`.`status`,'active','paused','completed','cancelled')"), "ASC"],
      ["startDate", "DESC"],
      ["id", "DESC"],
    ],
  });
}

async function findOwned(patientId, id, { transaction, lock } = {}) {
  const row = await PatientMedicine.findOne({
    where: { id, patientId },
    include: lock ? undefined : routineInclude,
    transaction,
    lock: lock ? transaction.LOCK.UPDATE : undefined,
  });
  if (!row) throw ApiError.notFound("Medicine not found");
  return row;
}

/** One routine plus its recent dose history (last 14 local days). */
async function getOne(patientId, id) {
  const routine = await findOwned(patientId, id);
  const since = new Date(Date.now() - 14 * 24 * 60 * MINUTE);
  const doses = await MedicineDoseLog.findAll({
    where: { patientMedicineId: routine.id, patientId, scheduledAt: { [Op.gte]: since } },
    order: [["scheduledAt", "DESC"]],
    limit: 120,
  });
  return { routine, doses };
}

// ── Routines: write ─────────────────────────────────────────────────────────
/** The DB row for one patient-entered medicine (identity from the catalogue when picked). */
function patientRow(patientId, item, master, timezone) {
  const startDate = item.startDate;
  const durationDays = item.durationDays ?? null;
  return {
    patientId,
    source: SRC.PATIENT,
    medicineMasterId: master ? master.id : null,
    medicineName: master ? master.medicineName : item.medicineName,
    genericName: (master ? master.genericName : item.genericName) || null,
    strength: (master ? master.strength : item.strength) || null,
    dosageForm: (master ? master.medicineType : item.dosageForm) || null,
    dose: item.dose || null,
    frequency: item.frequency || null,
    foodTiming: item.foodTiming || null,
    reminderTimes: sched.normalizeTimes(item.reminderTimes),
    daysOfWeek: sched.normalizeDays(item.daysOfWeek),
    timezone,
    startDate,
    durationDays,
    endDate: sched.endDateFor(startDate, durationDays),
    instructions: item.instructions || null,
    reminderEnabled: item.reminderEnabled !== false && sched.normalizeTimes(item.reminderTimes).length > 0,
    status: ST.ACTIVE,
    clientRequestId: item.clientRequestId || null,
  };
}

/**
 * Add one or more of the patient's OWN medicines in one transaction — the
 * "review and confirm" step of the multi-medicine cart. Each item carries its
 * own schedule. Re-sending the same `clientRequestId` returns the row already
 * made instead of a second one (safe retries from a flaky network).
 */
async function createMany(patientId, { items, timezone }) {
  const settings = await getSettings(patientId);
  const tz = timezone || settings.timezone || DEFAULT_PATIENT_TIMEZONE;

  const masterIds = [...new Set(items.map((i) => i.medicineMasterId).filter(Boolean).map(String))];
  const masters = masterIds.length
    ? await MedicineMaster.findAll({ where: { id: { [Op.in]: masterIds }, isActive: true } })
    : [];
  const masterById = new Map(masters.map((m) => [String(m.id), m]));
  for (const i of items) {
    if (i.medicineMasterId && !masterById.has(String(i.medicineMasterId))) {
      throw ApiError.notFound("A selected medicine is no longer in the catalogue");
    }
  }

  const reqIds = items.map((i) => i.clientRequestId).filter(Boolean);
  const existing = reqIds.length
    ? await PatientMedicine.findAll({ where: { patientId, clientRequestId: { [Op.in]: reqIds } } })
    : [];
  const seen = new Set(existing.map((r) => r.clientRequestId));
  const fresh = items.filter((i) => !i.clientRequestId || !seen.has(i.clientRequestId));

  let createdIds = [];
  if (fresh.length) {
    try {
      createdIds = await sequelize.transaction(async (transaction) => {
        const rows = await PatientMedicine.bulkCreate(
          fresh.map((i) => patientRow(patientId, i, i.medicineMasterId ? masterById.get(String(i.medicineMasterId)) : null, tz)),
          { transaction }
        );
        await generateDoses(rows, { transaction });
        const names = rows.map((r) => r.medicineName);
        await MedicineNotification.create(
          {
            userId: patientId,
            type: T.MEDICINE_ADDED,
            title: rows.length === 1 ? "Medicine added" : `${rows.length} medicines added`,
            message: `${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""} added to My Medicines.`,
            referenceId: rows.length === 1 ? rows[0].id : null,
            referenceType: NOTIFICATION_REFS.PATIENT_MEDICINE,
          },
          { transaction }
        );
        notifyRoutinesChanged(patientId, transaction);
        return rows.map((r) => r.id);
      });
    } catch (err) {
      // Two identical retries raced: the other request created them — return those.
      if (!(err instanceof UniqueConstraintError)) throw err;
    }
  }

  const ids = [...existing.map((r) => r.id), ...createdIds];
  const byReq = reqIds.length
    ? await PatientMedicine.findAll({ where: { patientId, clientRequestId: { [Op.in]: reqIds } }, attributes: ["id"] })
    : [];
  const all = [...new Set([...ids, ...byReq.map((r) => r.id)].map(String))];
  return PatientMedicine.findAll({ where: { patientId, id: { [Op.in]: all } }, include: routineInclude, order: [["id", "ASC"]] });
}

async function update(patientId, id, dto) {
  await sequelize.transaction(async (transaction) => {
    const row = await findOwned(patientId, id, { transaction, lock: true });
    if (!LIVE_ROUTINE.includes(row.status)) {
      throw ApiError.conflict("This medicine routine has ended and can no longer be changed.", {
        code: ERROR_CODES.PATIENT_MEDICINE_NOT_EDITABLE,
      });
    }
    if (row.source === SRC.PRESCRIPTION) {
      const locked = PRESCRIBED_LOCKED.filter((k) => dto[k] !== undefined);
      if (locked.length) {
        throw ApiError.conflict(
          "The doctor's prescribed instructions can't be changed here. You can change your reminder times.",
          { code: ERROR_CODES.PRESCRIBED_FIELD_LOCKED, details: { fields: locked } }
        );
      }
    }

    const patch = { ...dto };
    if (patch.reminderTimes !== undefined) patch.reminderTimes = sched.normalizeTimes(patch.reminderTimes);
    if (patch.daysOfWeek !== undefined) patch.daysOfWeek = sched.normalizeDays(patch.daysOfWeek);
    if (patch.startDate !== undefined || patch.durationDays !== undefined) {
      const start = patch.startDate ?? row.startDate;
      const days = patch.durationDays !== undefined ? patch.durationDays : row.durationDays;
      patch.endDate = sched.endDateFor(start, days);
    }
    const times = patch.reminderTimes ?? row.reminderTimes ?? [];
    if (patch.reminderEnabled === true && !times.length) patch.reminderEnabled = false;
    // First time a prescribed routine gets times: reminders switch on unless the patient said no.
    if (patch.reminderTimes?.length && !(row.reminderTimes ?? []).length && patch.reminderEnabled === undefined) {
      patch.reminderEnabled = true;
    }

    const scheduleChanged = SCHEDULE_FIELDS.some((k) => patch[k] !== undefined);
    await row.update(patch, { transaction });
    if (scheduleChanged) await rescheduleFuture([row], { transaction });
    notifyRoutinesChanged(patientId, transaction);
  });
  return findOwned(patientId, id);
}

/**
 * Pause / resume / stop. Paused and stopped routines lose their future,
 * un-actioned doses (so nothing reminds the patient); past history stays.
 */
async function setStatus(patientId, id, { status }) {
  await sequelize.transaction(async (transaction) => {
    const row = await findOwned(patientId, id, { transaction, lock: true });
    if (row.status === status) return; // idempotent
    const allowed =
      (row.status === ST.ACTIVE && [ST.PAUSED, ST.CANCELLED].includes(status)) ||
      (row.status === ST.PAUSED && [ST.ACTIVE, ST.CANCELLED].includes(status));
    if (!allowed) {
      throw ApiError.conflict(
        row.status === ST.COMPLETED ? "This routine is already completed." : "This routine has already been stopped.",
        { code: ERROR_CODES.PATIENT_MEDICINE_NOT_EDITABLE }
      );
    }
    await row.update(
      { status, statusReason: status === ST.ACTIVE ? null : REASON.PATIENT, statusChangedAt: new Date() },
      { transaction }
    );
    if (status === ST.ACTIVE) await generateDoses([row], { transaction });
    else await clearFutureDoses([row.id], { transaction });

    if (status !== ST.ACTIVE) {
      const stopped = status === ST.CANCELLED;
      await MedicineNotification.create(
        {
          userId: patientId,
          type: stopped ? T.MEDICINE_ROUTINE_STOPPED : T.MEDICINE_ROUTINE_PAUSED,
          title: stopped ? "Medicine stopped" : "Medicine paused",
          message: `Reminders for ${row.medicineName} are ${stopped ? "stopped" : "paused"}.`,
          referenceId: row.id,
          referenceType: NOTIFICATION_REFS.PATIENT_MEDICINE,
        },
        { transaction }
      );
    }
    notifyRoutinesChanged(patientId, transaction);
  });
  return findOwned(patientId, id);
}

// ── Doses ───────────────────────────────────────────────────────────────────
/**
 * Doses between `from` and `to` (UTC instants). Defaults to the patient's
 * local "today". Tops up the window and marks stale doses missed first, so
 * the answer is current even if the sweep has not run yet.
 */
async function listDoses(patientId, { from, to } = {}) {
  await topUpForPatient(patientId);
  await markMissed({ patientId });
  let start = from;
  let end = to;
  if (!start || !end) {
    const { timezone } = await getSettings(patientId);
    const today = sched.localDate(new Date(), timezone);
    start = start || sched.zonedToUtc(today, "00:00", timezone);
    end = end || sched.zonedToUtc(sched.addDays(today, 1), "00:00", timezone);
  }
  return MedicineDoseLog.findAll({
    where: {
      patientId,
      // A snoozed dose belongs to the range its NEW due time falls in, too.
      [Op.or]: [
        { scheduledAt: { [Op.gte]: start, [Op.lt]: end } },
        { dueAt: { [Op.gte]: start, [Op.lt]: end } },
      ],
    },
    include: doseInclude,
    order: [["scheduledAt", "ASC"], ["id", "ASC"]],
  });
}

async function history(patientId, { page = 1, limit = 30, patientMedicineId, status } = {}) {
  await markMissed({ patientId });
  const where = { patientId, scheduledAt: { [Op.lte]: new Date() } };
  if (patientMedicineId) where.patientMedicineId = patientMedicineId;
  if (status) where.status = status;
  const { rows, count } = await MedicineDoseLog.findAndCountAll({
    where,
    include: doseInclude,
    order: [["scheduledAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { doses: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
}

/**
 * Taken / Skip / Snooze on one dose. Locked row + status rules make every
 * action idempotent: a retried "taken" (offline queue, double tap, the
 * notification button AND the app) returns the same dose, never a second
 * record. Returns `{ dose, changed }`.
 */
async function doseAction(patientId, doseId, { action, snoozeMinutes, source = "web", actedAt }) {
  const now = new Date();
  const result = await sequelize.transaction(async (transaction) => {
    const dose = await MedicineDoseLog.findOne({
      where: { id: doseId, patientId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!dose) throw ApiError.notFound("Dose not found");
    const routine = await PatientMedicine.findOne({
      where: { id: dose.patientMedicineId, patientId },
      attributes: ["id", "status"],
      transaction,
    });

    // Idempotent repeats.
    if (action === DOSE_ACTIONS.TAKEN && dose.status === DS.TAKEN) return { dose, changed: false };
    if (action === DOSE_ACTIONS.SKIPPED && dose.status === DS.SKIPPED) return { dose, changed: false };

    if (dose.status === DS.TAKEN) {
      throw ApiError.conflict("This dose is already marked as taken.", { code: ERROR_CODES.DOSE_ALREADY_TAKEN });
    }
    if (dose.scheduledAt.getTime() - now.getTime() > ACT_AHEAD_MS) {
      throw ApiError.conflict("This dose isn't due yet.", { code: ERROR_CODES.DOSE_NOT_ACTIONABLE });
    }
    if (action === DOSE_ACTIONS.SNOOZE) {
      if (!OPEN_DOSE.includes(dose.status) || routine?.status !== ST.ACTIVE) {
        throw ApiError.conflict("Only an upcoming dose can be snoozed.", { code: ERROR_CODES.DOSE_NOT_ACTIONABLE });
      }
      if (dose.snoozeCount >= MAX_SNOOZES) {
        throw ApiError.conflict("This dose has been snoozed too many times.", { code: ERROR_CODES.DOSE_NOT_ACTIONABLE });
      }
    }
    // A queued offline action keeps the moment it happened, within sane bounds.
    let when = now;
    if (actedAt && action !== DOSE_ACTIONS.SNOOZE) {
      const t = new Date(actedAt);
      const floor = dose.scheduledAt.getTime() - ACT_AHEAD_MS;
      if (!Number.isNaN(t.getTime()) && t <= now && t.getTime() >= floor) when = t;
    }

    if (action === DOSE_ACTIONS.SNOOZE) {
      await dose.update(
        {
          status: DS.SNOOZED,
          dueAt: new Date(now.getTime() + snoozeMinutes * MINUTE),
          snoozeCount: dose.snoozeCount + 1,
          notifiedAt: null,
          actionSource: source,
        },
        { transaction }
      );
    } else {
      await dose.update(
        { status: action === DOSE_ACTIONS.TAKEN ? DS.TAKEN : DS.SKIPPED, actionAt: when, actionSource: source },
        { transaction }
      );
    }
    await MedicineDoseEvent.create(
      {
        doseLogId: dose.id,
        patientId,
        action: action === DOSE_ACTIONS.SNOOZE ? DS.SNOOZED : action,
        snoozeMinutes: action === DOSE_ACTIONS.SNOOZE ? snoozeMinutes : null,
        actedAt: when,
        source,
      },
      { transaction }
    );
    return { dose, changed: true };
  });

  const fresh = await MedicineDoseLog.findOne({ where: { id: doseId, patientId }, include: doseInclude });
  if (result.changed) realtime.emitToUser(patientId, DOSE_UPDATED_EVENT, serializeDose(fresh));
  return { dose: fresh, changed: result.changed };
}

// ── Dashboard summary ───────────────────────────────────────────────────────
function adherenceOf(counts) {
  const taken = counts.taken || 0;
  const due = taken + (counts.skipped || 0) + (counts.missed || 0);
  return { taken, skipped: counts.skipped || 0, missed: counts.missed || 0, due, percent: due ? Math.round((taken / due) * 100) : null };
}

async function statusCounts(patientId, from, to) {
  const rows = await MedicineDoseLog.findAll({
    where: { patientId, scheduledAt: { [Op.gte]: from, [Op.lt]: to } },
    attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    group: ["status"],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Real numbers from dose rows: today's doses by status, the next due dose,
 * and adherence (taken ÷ doses that were due: taken + skipped + missed) over
 * the last 7 and 30 days. Pending doses that are not due yet never count
 * against adherence, and delivered reminders never count as taken.
 */
async function summary(patientId) {
  await topUpForPatient(patientId);
  await markMissed({ patientId });
  const { timezone } = await getSettings(patientId);
  const now = new Date();
  const today = sched.localDate(now, timezone);
  const startToday = sched.zonedToUtc(today, "00:00", timezone);
  const startTomorrow = sched.zonedToUtc(sched.addDays(today, 1), "00:00", timezone);
  const start7 = sched.zonedToUtc(sched.addDays(today, -6), "00:00", timezone);
  const start30 = sched.zonedToUtc(sched.addDays(today, -29), "00:00", timezone);

  const [routineRows, todayCounts, week, month, next, daily] = await Promise.all([
    PatientMedicine.findAll({ where: { patientId }, attributes: ["status", "source", "reminderTimes"] }),
    statusCounts(patientId, startToday, startTomorrow),
    statusCounts(patientId, start7, startTomorrow),
    statusCounts(patientId, start30, startTomorrow),
    MedicineDoseLog.findOne({
      where: { patientId, status: { [Op.in]: OPEN_DOSE }, dueAt: { [Op.gte]: new Date(now.getTime() - DOSE_MISSED_AFTER_MINUTES * MINUTE) } },
      include: doseInclude,
      order: [["dueAt", "ASC"]],
    }),
    MedicineDoseLog.findAll({
      where: { patientId, scheduledAt: { [Op.gte]: start7, [Op.lt]: startTomorrow } },
      attributes: ["scheduledDate", "status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
      group: ["scheduledDate", "status"],
      raw: true,
    }),
  ]);

  const routines = { active: 0, paused: 0, completed: 0, cancelled: 0, prescribed: 0, own: 0, needsSetup: 0 };
  for (const r of routineRows) {
    routines[r.status] += 1;
    if (r.status === ST.ACTIVE || r.status === ST.PAUSED) {
      routines[r.source === SRC.PRESCRIPTION ? "prescribed" : "own"] += 1;
      if (r.status === ST.ACTIVE && !sched.normalizeTimes(r.reminderTimes).length) routines.needsSetup += 1;
    }
  }

  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = sched.addDays(today, -i);
    const counts = {};
    for (const r of daily) if (String(r.scheduledDate).slice(0, 10) === d) counts[r.status] = Number(r.n);
    days.push({ date: d, ...adherenceOf(counts), pending: (counts.pending || 0) + (counts.snoozed || 0) });
  }

  return {
    timezone,
    today: {
      date: today,
      total: Object.values(todayCounts).reduce((a, b) => a + b, 0),
      taken: todayCounts.taken || 0,
      pending: todayCounts.pending || 0,
      snoozed: todayCounts.snoozed || 0,
      skipped: todayCounts.skipped || 0,
      missed: todayCounts.missed || 0,
    },
    nextDose: next,
    routines,
    adherence: { week: adherenceOf(week), month: adherenceOf(month), days },
  };
}

// ── Prescription → patient sync ─────────────────────────────────────────────
/**
 * Copy a FINALIZED prescription's medicine lines into the patient's
 * medicines. Called after finalize commits; never throws (a signed
 * prescription must not fail because of this convenience copy).
 *
 * Sync rules (docs/medicine-management-31-10-2026/prescription-sync.md):
 *  - drafts never sync; only `finalized` prescriptions do;
 *  - one routine per prescription line, UNIQUE on prescription_item_id, so a
 *    retried finalize or a re-run is a no-op;
 *  - an AMENDMENT (new version) cancels the previous version's live routines
 *    with reason `prescription_amended` and creates the new ones; when the
 *    same medicine (name + strength) and frequency carry over, the patient's
 *    reminder times and course start date are kept, so a corrected typo does
 *    not reset their schedule;
 *  - the patient's own medicines are never touched.
 */
async function syncFromPrescription(prescriptionId) {
  try {
    const rx = await Prescription.findByPk(prescriptionId, {
      attributes: ["id", "doctorId", "patientId", "status", "rxNumber", "finalizedAt", "parentPrescriptionId"],
      include: [{ model: PrescriptionItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] }],
    });
    if (!rx || rx.status !== PRESCRIPTION_STATUS.FINALIZED || !rx.patientId) return { created: 0 };

    const items = (rx.items ?? []).filter((i) => String(i.medicineName ?? "").trim());
    const already = items.length
      ? await PatientMedicine.findAll({
          where: { prescriptionItemId: { [Op.in]: items.map((i) => i.id) } },
          attributes: ["prescriptionItemId"],
        })
      : [];
    const done = new Set(already.map((r) => String(r.prescriptionItemId)));
    const todo = items.filter((i) => !done.has(String(i.id)));

    const settings = await getSettings(rx.patientId);
    const tz = settings.timezone || DEFAULT_PATIENT_TIMEZONE;
    const startDate = sched.localDate(rx.finalizedAt ?? new Date(), tz);

    const previous = rx.parentPrescriptionId
      ? await PatientMedicine.findAll({
          where: { patientId: rx.patientId, prescriptionId: rx.parentPrescriptionId, status: { [Op.in]: LIVE_ROUTINE } },
        })
      : [];
    if (!todo.length && !previous.length) return { created: 0 };

    const ownIds = [...new Set(todo.map((i) => i.medicineId).filter(Boolean).map(String))];
    const masterIdsFromItems = todo.map((i) => i.medicineMasterId).filter(Boolean).map(String);
    const ownMeds = ownIds.length
      ? await Medicine.findAll({ where: { id: { [Op.in]: ownIds } }, attributes: ["id", "medicineMasterId", "genericName"] })
      : [];
    const ownById = new Map(ownMeds.map((m) => [String(m.id), m]));
    const masterIds = [
      ...new Set([...masterIdsFromItems, ...ownMeds.map((m) => m.medicineMasterId).filter(Boolean).map(String)]),
    ];
    const masters = masterIds.length
      ? await MedicineMaster.findAll({ where: { id: { [Op.in]: masterIds } }, attributes: ["id", "genericName"] })
      : [];
    const masterById = new Map(masters.map((m) => [String(m.id), m]));
    const prevByKey = new Map(previous.map((p) => [sched.medicineKey(p.medicineName, p.strength), p]));

    const created = await sequelize.transaction(async (transaction) => {
      const rows = todo.map((i) => {
        const own = i.medicineId ? ownById.get(String(i.medicineId)) : null;
        const masterId = i.medicineMasterId || own?.medicineMasterId || null;
        const name = sched.baseMedicineName(i.medicineName, i.strength);
        const durationDays = sched.durationToDays(i.durationDays, i.durationUnit);
        const prev = prevByKey.get(sched.medicineKey(name, i.strength));
        const carry = prev && String(prev.frequency ?? "") === String(i.frequency ?? "") ? prev : null;
        const start = carry ? carry.startDate : startDate;
        return {
          patientId: rx.patientId,
          source: SRC.PRESCRIPTION,
          prescriptionId: rx.id,
          prescriptionItemId: i.id,
          prescribedBy: rx.doctorId,
          medicineMasterId: masterId,
          medicineName: name,
          genericName: own?.genericName || (masterId ? masterById.get(String(masterId))?.genericName : null) || null,
          strength: i.strength || null,
          dosageForm: i.dosageForm || null,
          dose: i.dosage || null,
          frequency: i.frequency || null,
          foodTiming: i.timing || null,
          reminderTimes: carry ? sched.normalizeTimes(carry.reminderTimes) : [],
          daysOfWeek: carry ? carry.daysOfWeek : null,
          timezone: tz,
          startDate: start,
          durationDays,
          endDate: sched.endDateFor(start, durationDays),
          instructions: i.notes || null,
          prescribedSnapshot: {
            medicineName: i.medicineName,
            strength: i.strength ?? null,
            dosageForm: i.dosageForm ?? null,
            dosage: i.dosage ?? null,
            route: i.route ?? null,
            frequency: i.frequency ?? null,
            timing: i.timing ?? null,
            durationDays: i.durationDays ?? null,
            durationUnit: i.durationUnit ?? null,
            quantity: i.quantity ?? null,
            notes: i.notes ?? null,
            rxNumber: rx.rxNumber,
            finalizedAt: rx.finalizedAt,
          },
          reminderEnabled: carry ? Boolean(carry.reminderEnabled) : false,
          status: ST.ACTIVE,
          _prevId: prev ? prev.id : null,
        };
      });

      const made = rows.length
        ? await PatientMedicine.bulkCreate(
            rows.map(({ _prevId, ...r }) => r),
            { transaction }
          )
        : [];

      if (previous.length) {
        const now = new Date();
        const madeByPrev = new Map();
        rows.forEach((r, idx) => r._prevId && madeByPrev.set(String(r._prevId), made[idx]?.id ?? null));
        await clearFutureDoses(previous.map((p) => p.id), { transaction });
        await PatientMedicine.update(
          { status: ST.CANCELLED, statusReason: REASON.SUPERSEDED, statusChangedAt: now },
          { where: { id: { [Op.in]: previous.map((p) => p.id) } }, transaction }
        );
        const linked = previous.filter((p) => madeByPrev.get(String(p.id)));
        if (linked.length) {
          // One UPDATE: superseded_by_id = CASE id WHEN … THEN … END.
          const cases = linked.map((p) => `WHEN ${Number(p.id)} THEN ${Number(madeByPrev.get(String(p.id)))}`).join(" ");
          await PatientMedicine.update(
            { supersededById: sequelize.literal(`CASE id ${cases} END`) },
            { where: { id: { [Op.in]: linked.map((p) => p.id) } }, transaction }
          );
        }
      }

      await generateDoses(made, { transaction });

      const doctor = await User.findByPk(rx.doctorId, { attributes: ["name"], transaction });
      const dr = doctor?.name ? `Dr. ${String(doctor.name).replace(/^dr\.?\s*/i, "")}` : "Your doctor";
      const amended = previous.length > 0;
      if (made.length || amended) {
        await MedicineNotification.create(
          {
            userId: rx.patientId,
            type: amended ? T.MEDICINE_PRESCRIPTION_UPDATED : T.MEDICINE_PRESCRIBED,
            title: amended ? "Prescription updated" : "New medicines prescribed",
            message: amended
              ? `${dr} updated your prescription${rx.rxNumber ? ` ${rx.rxNumber}` : ""}. Please check your medicines and reminder times.`
              : `${dr} prescribed ${made.length} medicine${made.length === 1 ? "" : "s"}. Set your reminder times in My Medicines.`,
            referenceId: rx.id,
            referenceType: NOTIFICATION_REFS.PRESCRIPTION,
          },
          { transaction }
        );
      }
      notifyRoutinesChanged(rx.patientId, transaction);
      return made.length;
    });
    return { created };
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { created: 0 }; // a concurrent run already did it
    console.error(`⚠️  Could not sync prescription ${prescriptionId} to the patient's medicines:`, err.message);
    return { created: 0, error: err.message };
  }
}

module.exports = {
  DOSE_UPDATED_EVENT,
  ROUTINES_CHANGED_EVENT,
  getSettings,
  updateSettings,
  searchCatalogue,
  list,
  getOne,
  createMany,
  update,
  setStatus,
  listDoses,
  history,
  doseAction,
  summary,
  syncFromPrescription,
  // for the reminder sweep
  generateDoses,
  markMissed,
  clearFutureDoses,
};
