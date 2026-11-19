/**
 * Automatic follow-up reminder scheduler (docs/follow-up-reminders-07-09-2026).
 *
 * An in-process cron that runs every SCHEDULER_INTERVAL_MS (default 5 minutes).
 * Uses `FOR UPDATE SKIP LOCKED` to claim rows safely across multiple backend
 * instances. The scheduler is purely DB-driven — pending reminders survive
 * restarts, deploys, and crashes.
 *
 * Start:  reminderScheduler.start()   — called from server.js after DB auth
 * Stop:   reminderScheduler.stop()    — called on SIGTERM/SIGINT
 */
const { Op } = require("sequelize");
const { sequelize, FollowUpReminder, Booking, User, Clinic, DoctorProfile } = require("../models");
const { REMINDER_STATUS, SCHEDULER_INTERVAL_MS } = require("../config/constants");
const notificationService = require("./notificationService");

let intervalId = null;

/**
 * Process a batch of due reminders. Called every tick.
 *
 * Phase 1 (short transaction): claim rows with FOR UPDATE SKIP LOCKED.
 * Phase 2 (no lock held): dispatch notifications, then update status.
 */
async function tick() {
  let claimed;
  try {
    // Phase 1: Claim pending reminders whose trigger time has arrived.
    claimed = await sequelize.transaction(async (tx) => {
      const rows = await FollowUpReminder.findAll({
        where: {
          status: REMINDER_STATUS.PENDING,
          reminderAt: { [Op.lte]: new Date() },
        },
        limit: 50,
        lock: tx.LOCK.UPDATE,
        skipLocked: true,
        transaction: tx,
      });
      // Mark as processing so no other instance picks them up.
      for (const r of rows) {
        await r.update({ status: REMINDER_STATUS.PROCESSING }, { transaction: tx });
      }
      return rows;
    });
  } catch (err) {
    console.error("❌ Reminder scheduler tick (claim phase) failed:", err.message);
    return;
  }

  if (!claimed.length) return;

  console.log(`📬 Reminder scheduler: ${claimed.length} reminder(s) to process`);

  // Phase 2: Dispatch each reminder (no lock held).
  for (const row of claimed) {
    try {
      // Load full data needed for notification.
      const reminder = await FollowUpReminder.findByPk(row.id, {
        include: [
          {
            model: Booking,
            as: "booking",
            include: [
              {
                model: DoctorProfile,
                as: "doctor",
                include: [{ model: User, as: "user", attributes: ["id", "name"] }],
              },
              { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
            ],
          },
          { model: User, as: "patient", attributes: ["id", "name", "email", "phone"] },
          { model: User, as: "doctor", attributes: ["id", "name"] },
        ],
      });

      if (!reminder) {
        // Booking was deleted (CASCADE) — silently skip.
        continue;
      }

      const result = await notificationService.send(reminder);

      // Update channel statuses based on results.
      const emailStatus = result.email?.ok ? "sent" : result.email?.mock ? "sent" : "failed";
      const whatsappStatus = result.whatsapp?.ok ? "sent" : result.whatsapp?.mock ? "sent" : "failed";

      const allSent = emailStatus === "sent" && whatsappStatus === "sent";
      const anyFailed = emailStatus === "failed" || whatsappStatus === "failed";
      const anySent = emailStatus === "sent" || whatsappStatus === "sent";

      let finalStatus;
      if (allSent) {
        finalStatus = REMINDER_STATUS.SENT;
      } else if (anySent) {
        // Partial success — mark sent but log the failure.
        finalStatus = REMINDER_STATUS.SENT;
      } else if (row.retryCount + 1 >= row.maxRetries) {
        finalStatus = REMINDER_STATUS.FAILED;
      } else {
        finalStatus = REMINDER_STATUS.PENDING; // Will retry next tick
      }

      await row.update({
        status: finalStatus,
        emailStatus,
        whatsappStatus,
        retryCount: finalStatus === REMINDER_STATUS.PENDING ? row.retryCount + 1 : row.retryCount,
        lastError: anyFailed ? JSON.stringify({ email: result.email, whatsapp: result.whatsapp }) : null,
        sentAt: allSent || anySent ? new Date() : row.sentAt,
      });

      if (allSent || anySent) {
        console.log(`✅ Reminder ${row.id} sent (${emailStatus}/${whatsappStatus})`);
      } else {
        console.log(`⚠️  Reminder ${row.id} failed, retry ${row.retryCount + 1}/${row.maxRetries}`);
      }
    } catch (err) {
      console.error(`❌ Reminder ${row.id} dispatch failed:`, err.message);
      const shouldRetry = row.retryCount + 1 < row.maxRetries;
      await row.update({
        status: shouldRetry ? REMINDER_STATUS.PENDING : REMINDER_STATUS.FAILED,
        retryCount: row.retryCount + 1,
        lastError: err.message,
      });
    }
  }
}

/** Start the scheduler. Safe to call multiple times (no-op if already running). */
function start() {
  if (intervalId) return;
  console.log(`⏰ Reminder scheduler started (interval: ${SCHEDULER_INTERVAL_MS / 1000}s)`);
  // Run immediately on start, then on interval.
  tick().catch((err) => console.error("❌ Initial reminder tick failed:", err.message));
  intervalId = setInterval(() => {
    tick().catch((err) => console.error("❌ Reminder tick failed:", err.message));
  }, SCHEDULER_INTERVAL_MS);
}

/** Stop the scheduler gracefully. */
function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("⏰ Reminder scheduler stopped");
  }
}

module.exports = { start, stop, tick };
