/**
 * Consultation sessions and the queue inside them (docs/consultation-queue).
 *
 * A session is a doctor's consulting WINDOW at one place on one day — "Clinic A,
 * Thursday, 9am to 4pm". Patients book the day, not a time, and receive a token.
 *
 * Two ideas hold this module together.
 *
 * **Sessions are materialised lazily.** Nothing pre-creates a row for every
 * doctor × clinic × day; `resolveSession` expands the weekly template the first
 * time somebody books or the doctor opens their day. The UNIQUE key on
 * (doctor, date, clinic_key, start_time) makes the race harmless.
 *
 * **Position is derived, never stored.** A token is immutable — #6 stays #6 —
 * while the position is one indexed COUNT of who is still waiting ahead. That is
 * what makes the number fall from 4 to 3 the moment a consult finishes, or when
 * an unpaid hold expires, with nothing to keep in sync.
 */
const { Op, fn, col, literal } = require("sequelize");
const { sequelize, ConsultationSession, Booking, Clinic } = require("../models");
const ApiError = require("../utils/ApiError");
const availabilityService = require("./availability.service");
const {
  ERROR_CODES,
  SESSION_STATUS,
  QUEUE_STATE,
  LIVE_QUEUE_STATUSES,
  BOOKING_STATUS,
  SESSION_AUTO_CLOSE_HOURS,
  AVG_CONSULT_MIN_SAMPLE,
  DEFAULT_CONSULT_MINUTES,
} = require("../config/constants");

/** "HH:mm[:ss]" → "HH:mm". */
const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));

/** UTC day-of-week for a "YYYY-MM-DD". */
const dayOfWeekOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

// ── Materialising a day ──────────────────────────────────────────────────────
/**
 * The session for (doctor, clinic|online, date), creating it from the weekly
 * template on first use.
 *
 * Every gate lives in `availability.service.resolveWindows` and is inherited
 * here for free: the publicly-listed check, the blocked-date exception, and the
 * clinic-ownership check. A blocked date returns no windows, so nothing is
 * bookable — exactly as before the queue existed.
 *
 * Returns `null` when the doctor offers nothing that day, which callers render
 * as "no session", never as an error.
 */
async function resolveSession({ doctorId, clinicId = null, dateStr, requireListed = true, create = true }) {
  const mode = clinicId ? "clinic" : "online";
  const windows = await availabilityService.resolveWindows({
    doctorId,
    mode,
    clinicId,
    dateStr,
    dayOfWeek: dayOfWeekOf(dateStr),
    requireListed,
  });
  if (!windows.length) return null;

  // One template row per window; the earliest is the day's session. A doctor
  // running a morning AND an evening OPD at the same clinic gets two rows, told
  // apart by start_time — that is what the UNIQUE key is keyed on.
  const win = [...windows].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))[0];
  const startTime = hhmm(win.startTime);
  const endTime = hhmm(win.endTime);

  const where = { doctorId, clinicId, sessionDate: dateStr, startTime };
  const found = await ConsultationSession.findOne({ where });
  if (found) return found;
  if (!create) {
    // A shape the read paths can render without writing a row: nobody has
    // booked this day yet, so it has no id.
    return ConsultationSession.build({
      ...where,
      endTime,
      maxBookings: win.maxBookings ?? null,
      avgConsultMinutes: win.slotDurationMinutes ?? null,
    });
  }

  try {
    return await ConsultationSession.create({
      ...where,
      endTime,
      maxBookings: win.maxBookings ?? null,
      avgConsultMinutes: win.slotDurationMinutes ?? null,
    });
  } catch (err) {
    // Two patients booking the day's FIRST appointment at the same instant.
    // The UNIQUE key let one through; the other reads what it created.
    if (err.name === "SequelizeUniqueConstraintError") return ConsultationSession.findOne({ where });
    throw err;
  }
}

/**
 * Every session the DOCTOR has on one date, across every location.
 *
 * Their own console, so `requireListed: false` — the public-listing gate is
 * about patient discovery, and a doctor mid-verification still has a day to
 * run. Rows already materialised are returned as they are; a location with a
 * window but no bookings yet is built unsaved, so opening the console never
 * writes.
 */
async function listForDoctorDate(doctorId, dateStr) {
  const existing = await ConsultationSession.findAll({
    where: { doctorId, sessionDate: dateStr },
    order: [["startTime", "ASC"]],
  });
  const seen = new Set(existing.map((s) => `${s.clinicId ?? 0}|${hhmm(s.startTime)}`));

  const clinics = await Clinic.findAll({ where: { doctorId, isActive: true }, attributes: ["id"] });
  const out = [...existing];
  for (const clinicId of [null, ...clinics.map((c) => c.id)]) {
    const built = await resolveSession({
      doctorId,
      clinicId,
      dateStr,
      requireListed: false,
      create: false,
    });
    if (built && !built.id && !seen.has(`${clinicId ?? 0}|${hhmm(built.startTime)}`)) out.push(built);
  }
  return out.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
}

/** Every session the doctor offers between two dates, materialised or not. */
async function listRange({ doctorId, clinicId = null, from, to, requireListed = true }) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    // `create: false` — reading a doctor's calendar must never write rows.
    const s = await resolveSession({ doctorId, clinicId, dateStr, requireListed, create: false });
    if (s) out.push(s);
  }
  return out;
}

// ── Counting ─────────────────────────────────────────────────────────────────
/** Live bookings per session id, in ONE grouped query — never one per session. */
async function countsFor(sessionIds) {
  const ids = [...new Set(sessionIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await Booking.findAll({
    where: { sessionId: { [Op.in]: ids }, status: { [Op.in]: LIVE_QUEUE_STATUSES } },
    attributes: ["sessionId", [fn("COUNT", col("id")), "n"]],
    group: ["sessionId"],
    raw: true,
  });
  return new Map(rows.map((r) => [String(r.sessionId), Number(r.n)]));
}

// ── The patient's live view ──────────────────────────────────────────────────
/**
 * Where this booking stands right now.
 *
 * ONE indexed COUNT does the work:
 *
 *   waiting AND live AND queue_number < mine  →  how many are ahead
 *
 * Unpaid holds count as ahead: they hold a token and may still pay. When one
 * expires it drops out and the position corrects itself on the next poll —
 * which is the same mechanism that makes a completed consult move everyone up.
 */
async function queueView(booking) {
  if (!booking.sessionId || booking.queueNumber == null) return null;

  const session = await ConsultationSession.findByPk(booking.sessionId);
  if (!session) return null;
  await autoCloseStale();

  const ahead = await Booking.count({
    where: {
      sessionId: booking.sessionId,
      queueState: QUEUE_STATE.WAITING,
      status: { [Op.in]: LIVE_QUEUE_STATUSES },
      queueNumber: { [Op.lt]: booking.queueNumber },
    },
  });

  // Who is being seen, as a TOKEN — never the other patient's name or id.
  let nowServing = null;
  let servingStartedAt = null;
  if (session.currentBookingId) {
    const cur = await Booking.findByPk(session.currentBookingId, {
      attributes: ["queueNumber", "consultStartedAt"],
    });
    nowServing = cur?.queueNumber ?? null;
    servingStartedAt = cur?.consultStartedAt ?? null;
  }

  const avgMinutes = session.avgConsultMinutes ?? DEFAULT_CONSULT_MINUTES;
  /*
   * "Measured" must mean measured.
   *
   * A session is SEEDED with the doctor's template estimate, so a non-null
   * average proves nothing — `refreshAverage` only overwrites it once
   * AVG_CONSULT_MIN_SAMPLE consults have actually finished. Counting those is
   * the only honest test, and it is one indexed COUNT on a table already keyed
   * by session.
   */
  const done = await Booking.count({
    where: { sessionId: booking.sessionId, queueState: QUEUE_STATE.DONE },
  });
  const measured = done >= AVG_CONSULT_MIN_SAMPLE;

  /*
   * ETA = when the doctor is likely to reach this patient.
   *
   * Counted from the CURRENT consult's start when one is running, else from the
   * later of now and the session's own start — a session that has not opened yet
   * must not promise a slot in the past.
   */
  const base = servingStartedAt
    ? new Date(servingStartedAt)
    : new Date(Math.max(Date.now(), new Date(`${session.sessionDate}T${hhmm(session.startTime)}:00`).getTime()));
  const estimatedStartAt = new Date(base.getTime() + ahead * avgMinutes * 60_000);

  return {
    token: booking.queueNumber,
    position: ahead + 1,
    aheadOfMe: ahead,
    queueState: booking.queueState,
    sessionStatus: session.status,
    doctorBusy: Boolean(session.currentBookingId),
    nowServing,
    estimatedStartAt: estimatedStartAt.toISOString(),
    etaConfidence: measured ? "measured" : "estimated",
    /*
     * The video gate, and it MUST match videoSession.assertQueueTurn exactly.
     *
     * These are two expressions of one rule — this one paints the button, that
     * one guards the room — and when they drifted the patient saw "you can't
     * join yet" for a call the API would have let them into. So the rule is
     * stated the same way in both places: you may join if you are the one being
     * seen, OR if the doctor is free.
     *
     * "Doctor is free" rather than "your token is next" is deliberate: patient
     * 1 never turning up must not trap everyone behind an empty chair.
     */
    canJoinCall:
      (booking.queueState === QUEUE_STATE.WAITING || booking.queueState === QUEUE_STATE.SERVING) &&
      (booking.queueState === QUEUE_STATE.SERVING || !session.currentBookingId),
    session: {
      id: String(session.id),
      date: session.sessionDate,
      startTime: hhmm(session.startTime),
      endTime: hhmm(session.endTime),
      status: session.status,
    },
  };
}

// ── The doctor's console ─────────────────────────────────────────────────────
/** A session the doctor owns, or 404. */
async function ownedSession(doctorId, id) {
  const session = await ConsultationSession.findOne({ where: { id, doctorId } });
  if (!session) {
    throw new ApiError(404, "Session not found", { code: ERROR_CODES.SESSION_NOT_FOUND });
  }
  return session;
}

/** The day's tokens in service order, with the patient each belongs to. */
function listQueue(sessionId) {
  return Booking.findAll({
    where: { sessionId, status: { [Op.in]: [...LIVE_QUEUE_STATUSES, BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW] } },
    order: [["queueNumber", "ASC"]],
    include: [{ association: "patient", attributes: ["id", "name", "phone", "profilePhotoUrl"] }],
  });
}

/** Per-state counts for one session, in one grouped query. */
async function queueCounts(sessionId) {
  const rows = await Booking.findAll({
    where: { sessionId, queueState: { [Op.ne]: null } },
    attributes: ["queueState", [fn("COUNT", col("id")), "n"]],
    group: ["queueState"],
    raw: true,
  });
  const counts = { waiting: 0, serving: 0, done: 0, skipped: 0 };
  for (const r of rows) counts[r.queueState] = Number(r.n);
  return counts;
}

const start = async (doctorId, id) => {
  const session = await ownedSession(doctorId, id);
  if ([SESSION_STATUS.COMPLETED, SESSION_STATUS.CANCELLED].includes(session.status)) {
    throw new ApiError(409, "That session is closed", { code: ERROR_CODES.SESSION_CLOSED });
  }
  session.status = SESSION_STATUS.IN_PROGRESS;
  session.startedAt = session.startedAt ?? new Date();
  await session.save();
  return session;
};

const pause = async (doctorId, id) => {
  const session = await ownedSession(doctorId, id);
  session.status = SESSION_STATUS.PAUSED;
  await session.save();
  return session;
};

const resume = async (doctorId, id) => {
  const session = await ownedSession(doctorId, id);
  session.status = SESSION_STATUS.IN_PROGRESS;
  await session.save();
  return session;
};

/**
 * Close the day. Waiting tokens are LEFT waiting on purpose — marking them
 * no-show is a clinical judgement the doctor makes per patient, not something
 * closing a session should do to thirty people at once.
 */
const end = async (doctorId, id) => {
  const session = await ownedSession(doctorId, id);
  session.status = SESSION_STATUS.COMPLETED;
  session.endedAt = new Date();
  session.currentBookingId = null;
  await session.save();
  return session;
};

/** Set or clear the day's cap without touching the weekly template. */
const setCap = async (doctorId, id, maxBookings) => {
  const session = await ownedSession(doctorId, id);
  session.maxBookings = maxBookings ?? null;
  await session.save();
  return session;
};

/**
 * Put one booking in the chair.
 *
 * Refuses while somebody else is being seen: two patients "in consultation" at
 * once is not a state a clinic can be in, and it would make `nowServing` a lie
 * for everybody waiting. The doctor completes or skips first.
 */
async function serve(doctorId, session, booking) {
  if (session.currentBookingId && String(session.currentBookingId) !== String(booking.id)) {
    throw new ApiError(409, "Finish or skip the current patient first", {
      code: ERROR_CODES.QUEUE_ALREADY_SERVING,
    });
  }
  const now = new Date();
  await sequelize.transaction(async (tx) => {
    booking.queueState = QUEUE_STATE.SERVING;
    booking.calledAt = booking.calledAt ?? now;
    booking.consultStartedAt = booking.consultStartedAt ?? now;
    await booking.save({ transaction: tx });

    // Calling a patient in IS starting the session — a doctor who goes straight
    // to work must not be blocked by a button they never pressed.
    session.currentBookingId = booking.id;
    if ([SESSION_STATUS.SCHEDULED, SESSION_STATUS.PAUSED].includes(session.status)) {
      session.status = SESSION_STATUS.IN_PROGRESS;
      session.startedAt = session.startedAt ?? now;
    }
    await session.save({ transaction: tx });
  });
  return booking;
}

/**
 * The doctor has OPENED this consultation's call — make the queue say so.
 *
 * Distinct from `serve()` on purpose. The console's "Call in" refuses while
 * somebody else is mid-consult, which is the right guard for a deliberate
 * button. This path is different: the doctor is demonstrably in the room, and
 * the patient is waiting on the other side of a gate that only opens for
 * `serving`. Refusing here would leave the two of them staring at each other
 * through a closed door — the doctor in an empty call, the patient told "the
 * doctor hasn't called you in yet".
 *
 * So this SWITCHES rather than refuses. Whoever was being served returns to
 * `waiting` — they keep their token and their place, because they were never
 * completed, only stepped away from.
 */
async function serveOnJoin(booking) {
  if (!booking.sessionId || booking.queueState === QUEUE_STATE.SERVING) return;
  // Only a live token can be called in. A done/skipped booking the doctor
  // re-opens to review must not silently re-enter the queue.
  if (booking.queueState !== QUEUE_STATE.WAITING) return;

  const session = await ConsultationSession.findByPk(booking.sessionId);
  if (!session) return;

  const now = new Date();
  await sequelize.transaction(async (tx) => {
    if (session.currentBookingId && String(session.currentBookingId) !== String(booking.id)) {
      await Booking.update(
        { queueState: QUEUE_STATE.WAITING },
        { where: { id: session.currentBookingId, queueState: QUEUE_STATE.SERVING }, transaction: tx }
      );
    }
    await Booking.update(
      { queueState: QUEUE_STATE.SERVING, calledAt: booking.calledAt ?? now, consultStartedAt: booking.consultStartedAt ?? now },
      { where: { id: booking.id }, transaction: tx }
    );
    session.currentBookingId = booking.id;
    if ([SESSION_STATUS.SCHEDULED, SESSION_STATUS.PAUSED].includes(session.status)) {
      session.status = SESSION_STATUS.IN_PROGRESS;
      session.startedAt = session.startedAt ?? now;
    }
    await session.save({ transaction: tx });
  });
  // Keep the in-memory row honest for the caller that just used it.
  booking.queueState = QUEUE_STATE.SERVING;
}

/** The lowest waiting token in the session. */
async function callNext(doctorId, id) {
  const session = await ownedSession(doctorId, id);
  const next = await Booking.findOne({
    where: {
      sessionId: session.id,
      queueState: QUEUE_STATE.WAITING,
      status: { [Op.in]: LIVE_QUEUE_STATUSES },
    },
    order: [["queueNumber", "ASC"]],
  });
  if (!next) throw new ApiError(409, "Nobody is waiting in this session");
  const booking = await serve(doctorId, session, next);
  return { session, booking };
}

/** Serve one specific token — out of order, for the patient standing there. */
async function startConsult(doctorId, bookingId) {
  const booking = await Booking.findOne({ where: { id: bookingId, doctorId } });
  if (!booking?.sessionId) throw ApiError.notFound("Booking not found");
  const session = await ownedSession(doctorId, booking.sessionId);
  await serve(doctorId, session, booking);
  return { session, booking };
}

/** Move a token aside. They keep their number and can be called back in. */
async function skip(doctorId, bookingId) {
  const booking = await Booking.findOne({ where: { id: bookingId, doctorId } });
  if (!booking?.sessionId) throw ApiError.notFound("Booking not found");
  const session = await ownedSession(doctorId, booking.sessionId);

  await sequelize.transaction(async (tx) => {
    booking.queueState = QUEUE_STATE.SKIPPED;
    await booking.save({ transaction: tx });
    if (String(session.currentBookingId) === String(booking.id)) {
      session.currentBookingId = null;
      await session.save({ transaction: tx });
    }
  });
  return booking;
}

// ── Measured average ─────────────────────────────────────────────────────────
/**
 * Recompute a session's average from its OWN finished consults.
 *
 * One aggregate, no counter column to drift. Held back until
 * AVG_CONSULT_MIN_SAMPLE consults are done: below that the sample is noise, and
 * a single long first patient would tell everyone else to come back tomorrow.
 */
async function refreshAverage(sessionId, tx) {
  const [row] = await Booking.findAll({
    where: {
      sessionId,
      queueState: QUEUE_STATE.DONE,
      consultStartedAt: { [Op.ne]: null },
      consultEndedAt: { [Op.ne]: null },
    },
    attributes: [
      [fn("COUNT", col("id")), "n"],
      [fn("AVG", literal("TIMESTAMPDIFF(MINUTE, consult_started_at, consult_ended_at)")), "avg"],
    ],
    raw: true,
    transaction: tx,
  });
  const n = Number(row?.n ?? 0);
  const avg = Number(row?.avg ?? 0);
  if (n < AVG_CONSULT_MIN_SAMPLE || !avg) return;
  await ConsultationSession.update(
    { avgConsultMinutes: Math.max(1, Math.round(avg)) },
    { where: { id: sessionId }, transaction: tx }
  );
}

// ── Housekeeping ─────────────────────────────────────────────────────────────
/**
 * Close sessions nobody ended.
 *
 * Swept on READ (the doctor's session list, the patient's queue poll) rather
 * than by a cron, exactly like `expireStaleHolds` — one UPDATE, and no new
 * moving part to deploy and monitor.
 *
 * CONVERT_TZ with the fixed IST offset, never the named zone: on a MySQL whose
 * `mysql.time_zone*` tables were never loaded the named form returns NULL and
 * the comparison silently matches nothing.
 */
async function autoCloseStale() {
  await ConsultationSession.update(
    { status: SESSION_STATUS.COMPLETED, endedAt: new Date(), currentBookingId: null },
    {
      where: {
        status: { [Op.in]: [SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.PAUSED] },
        [Op.and]: literal(
          `TIMESTAMPADD(HOUR, ${SESSION_AUTO_CLOSE_HOURS}, TIMESTAMP(session_date, end_time)) < NOW()`
        ),
      },
    }
  );
}

/** The clinic a session belongs to — for serializing a public session list. */
const clinicOf = (id) => (id ? Clinic.findByPk(id, { attributes: ["id", "name", "city"] }) : null);

module.exports = {
  resolveSession,
  listForDoctorDate,
  listRange,
  countsFor,
  queueView,
  ownedSession,
  listQueue,
  queueCounts,
  start,
  pause,
  resume,
  end,
  setCap,
  callNext,
  serveOnJoin,
  startConsult,
  skip,
  refreshAverage,
  autoCloseStale,
  clinicOf,
};
