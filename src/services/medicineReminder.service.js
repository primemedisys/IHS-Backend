/**
 * The medicine reminder sweep (migration 055). An in-process interval, like
 * reminderScheduler.service — purely DB-driven, so nothing is lost across
 * restarts and `FOR UPDATE SKIP LOCKED` keeps several API instances from
 * sending the same reminder twice. No Redis / queue is needed at this volume.
 *
 * Each tick:
 *   1. due reminders  — open doses whose due time arrived get ONE in-app
 *      notification (medicine_notifications → Socket.IO push to the website
 *      and the open mobile app). Privacy mode hides the medicine name.
 *   2. missed         — doses still open past the grace period → `missed`.
 *   3. completion     — active routines past their end date → `completed`.
 *   4. top-up (hourly) — keep the rolling dose window filled.
 *
 * This channel reaches the website only while it is open. Closed apps rely on
 * the phone's own local notifications, scheduled by the patient app from the
 * same dose rows (docs/medicine-management-31-10-2026/mobile-notifications.md).
 */
const { Op } = require("sequelize");
const {
  sequelize,
  PatientMedicine,
  MedicineDoseLog,
  PatientMedicineSettings,
  MedicineNotification,
} = require("../models");
const patientMedicine = require("./patientMedicine.service");
const sched = require("../utils/medicineSchedule");
const {
  DOSE_STATUS: DS,
  PATIENT_MEDICINE_STATUS: ST,
  PATIENT_MEDICINE_STATUS_REASONS: REASON,
  DOSE_NOTIFY_STALE_MINUTES,
  MEDICINE_REMINDER_INTERVAL_MS,
  NOTIFICATION_TYPES: T,
  NOTIFICATION_REFS,
  DEFAULT_PATIENT_TIMEZONE,
} = require("../config/constants");

const MINUTE = 60 * 1000;
const TOP_UP_EVERY_MS = 60 * MINUTE;
const BATCH = 200;
const FOOD = { before_food: "before food", after_food: "after food", with_food: "with food" };

let intervalId = null;
let running = false;
let lastTopUp = 0;

/** "08:00" → "8:00 AM". */
function clock(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Reminder text. Privacy mode → no medicine name, dose or instructions. */
function reminderText(dose, routine, privacy) {
  const when = clock(dose.scheduledTime);
  const snoozed = dose.status === DS.SNOOZED;
  if (privacy) {
    return { title: "Medicine reminder", message: `It's time for your ${when} medicine${snoozed ? " (snoozed)" : ""}.` };
  }
  const name = [routine.medicineName, routine.strength].filter(Boolean).join(" ");
  const parts = [routine.dose, FOOD[routine.foodTiming]].filter(Boolean).join(", ");
  return {
    title: snoozed ? "Snoozed medicine reminder" : "Medicine reminder",
    message: `${name}${parts ? ` — ${parts}` : ""} (${when}).`,
  };
}

/** 1) One in-app notification per due dose, claimed with SKIP LOCKED. */
async function sendDueReminders(now = new Date()) {
  const stale = new Date(now.getTime() - DOSE_NOTIFY_STALE_MINUTES * MINUTE);
  return sequelize.transaction(async (transaction) => {
    const doses = await MedicineDoseLog.findAll({
      where: {
        status: { [Op.in]: [DS.PENDING, DS.SNOOZED] },
        notifiedAt: null,
        dueAt: { [Op.lte]: now, [Op.gte]: stale },
      },
      limit: BATCH,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (!doses.length) return 0;

    const routineIds = [...new Set(doses.map((d) => String(d.patientMedicineId)))];
    const patientIds = [...new Set(doses.map((d) => String(d.patientId)))];
    const [routines, settings] = await Promise.all([
      PatientMedicine.findAll({ where: { id: { [Op.in]: routineIds } }, transaction }),
      PatientMedicineSettings.findAll({ where: { patientId: { [Op.in]: patientIds } }, transaction }),
    ]);
    const routineById = new Map(routines.map((r) => [String(r.id), r]));
    const settingsBy = new Map(settings.map((s) => [String(s.patientId), s]));

    const notes = [];
    for (const d of doses) {
      const r = routineById.get(String(d.patientMedicineId));
      const s = settingsBy.get(String(d.patientId));
      if (!r || r.status !== ST.ACTIVE || !r.reminderEnabled || s?.webReminders === false) continue;
      const { title, message } = reminderText(d, r, Boolean(s?.privacyMode));
      notes.push({
        userId: d.patientId,
        type: T.MEDICINE_DOSE_DUE,
        title,
        message,
        referenceId: d.id,
        referenceType: NOTIFICATION_REFS.MEDICINE_DOSE,
      });
    }
    // Claimed either way: a dose whose reminders are off is not re-examined every minute.
    await MedicineDoseLog.update(
      { notifiedAt: now },
      { where: { id: { [Op.in]: doses.map((d) => d.id) } }, transaction }
    );
    if (notes.length) await MedicineNotification.bulkCreate(notes, { transaction });
    return notes.length;
  });
}

/** 3) Active routines whose last day (in their own zone) has passed. */
async function completeEnded(now = new Date()) {
  const horizon = sched.addDays(now.toISOString().slice(0, 10), 1);
  return sequelize.transaction(async (transaction) => {
    const candidates = await PatientMedicine.findAll({
      where: { status: ST.ACTIVE, endDate: { [Op.ne]: null, [Op.lt]: horizon } },
      limit: BATCH,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    const ended = candidates.filter((r) => {
      const tz = sched.isValidTimeZone(r.timezone) ? r.timezone : DEFAULT_PATIENT_TIMEZONE;
      return sched.localDate(now, tz) > String(r.endDate).slice(0, 10);
    });
    if (!ended.length) return 0;
    await PatientMedicine.update(
      { status: ST.COMPLETED, statusReason: REASON.ENDED, statusChangedAt: now },
      { where: { id: { [Op.in]: ended.map((r) => r.id) } }, transaction }
    );
    await MedicineNotification.bulkCreate(
      ended.map((r) => ({
        userId: r.patientId,
        type: T.MEDICINE_ROUTINE_COMPLETED,
        title: "Medicine course completed",
        message: `Your ${r.medicineName} course ended on ${String(r.endDate).slice(0, 10)}.`,
        referenceId: r.id,
        referenceType: NOTIFICATION_REFS.PATIENT_MEDICINE,
      })),
      { transaction }
    );
    return ended.length;
  });
}

/** 4) Keep every active routine's window filled (hourly). */
async function topUpAll() {
  let lastId = 0;
  for (;;) {
    const routines = await PatientMedicine.findAll({
      where: { status: ST.ACTIVE, id: { [Op.gt]: lastId } },
      attributes: ["id", "patientId", "status", "reminderTimes", "daysOfWeek", "timezone", "startDate", "endDate"],
      order: [["id", "ASC"]],
      limit: BATCH,
    });
    if (!routines.length) return;
    await patientMedicine.generateDoses(routines);
    lastId = routines[routines.length - 1].id;
    if (routines.length < BATCH) return;
  }
}

async function tick() {
  if (running) return; // a slow tick never overlaps the next one
  running = true;
  const now = new Date();
  try {
    await sendDueReminders(now);
    await patientMedicine.markMissed({ now });
    await completeEnded(now);
    if (now.getTime() - lastTopUp >= TOP_UP_EVERY_MS) {
      await topUpAll();
      lastTopUp = now.getTime();
    }
  } catch (err) {
    console.error("❌ Medicine reminder tick failed:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (intervalId) return;
  console.log(`💊 Medicine reminder sweep started (interval: ${MEDICINE_REMINDER_INTERVAL_MS / 1000}s)`);
  void tick();
  intervalId = setInterval(() => void tick(), MEDICINE_REMINDER_INTERVAL_MS);
}

function stop() {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}

module.exports = { start, stop, tick, sendDueReminders, completeEnded, reminderText };
