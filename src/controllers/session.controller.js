/**
 * Consultation-queue controllers (docs/consultation-queue). Thin: every rule
 * lives in session.service, every shape in session.validator, every response
 * body in utils/serializers.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const sessionService = require("../services/session.service");
const {
  serializeSessionPublic,
  serializeSessionForDoctor,
  serializeQueueEntry,
} = require("../utils/serializers");
const schema = require("../validators/session.validator");
const ApiError = require("../utils/ApiError");
const { SESSION_HORIZON_DAYS, QUEUE_POLL_SECONDS } = require("../config/constants");

/** "YYYY-MM-DD" for today, and for today + n days. */
const todayStr = () => new Date().toISOString().slice(0, 10);
const plusDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * PUBLIC — which DAYS a doctor is consulting, and how full each one is.
 *
 * Replaces the old `/doctors/:id/slots`. The query is validated here rather
 * than through the middleware because Express 5 makes `req.query` read-only.
 */
exports.publicSessions = asyncHandler(async (req, res) => {
  const { value, error } = schema.sessionQuery.validate(req.query, {
    convert: true,
    stripUnknown: true,
  });
  if (error) {
    throw new ApiError(422, "Invalid session query", {
      details: { query: error.details.map((d) => d.message.replace(/"/g, "")) },
    });
  }

  const doctorId = Number(req.params.id);
  const clinicId = value.mode === "clinic" ? value.clinicId : null;
  const from = value.from ? value.from.toISOString().slice(0, 10) : todayStr();
  const to = value.to
    ? value.to.toISOString().slice(0, 10)
    : plusDays(from, value.days ?? SESSION_HORIZON_DAYS);

  const sessions = await sessionService.listRange({ doctorId, clinicId, from, to });
  // ONE grouped count for the whole range — never one query per day.
  const counts = await sessionService.countsFor(sessions.map((s) => s.id));
  const clinic = await sessionService.clinicOf(clinicId);

  return ok(
    res,
    {
      doctorId: String(doctorId),
      mode: value.mode,
      clinicId: clinicId ? String(clinicId) : null,
      from,
      to,
      sessions: sessions.map((s) =>
        serializeSessionPublic(s, { booked: counts.get(String(s.id)) ?? 0, clinic })
      ),
    },
    "Consulting days"
  );
});

/** PATIENT — where my booking stands right now. Polled. */
exports.myQueue = asyncHandler(async (req, res) => {
  const bookingService = require("../services/booking.service");
  const booking = await bookingService.getForPatient(req.user.id, req.params.id);
  const view = await sessionService.queueView(booking);
  if (!view) {
    // A booking made before the queue existed has no place in one. Saying so is
    // better than inventing a position.
    return ok(res, { queued: false, pollSeconds: QUEUE_POLL_SECONDS }, "Not a queued booking");
  }
  return ok(res, { queued: true, bookingId: String(booking.id), ...view, pollSeconds: QUEUE_POLL_SECONDS }, "Queue");
});

// ── Doctor console ───────────────────────────────────────────────────────────
/** The doctor's sessions for a day (default today), across every location. */
exports.listForDoctor = asyncHandler(async (req, res) => {
  const { value, error } = schema.doctorSessionQuery.validate(req.query, {
    convert: true,
    stripUnknown: true,
  });
  if (error) throw new ApiError(422, "Invalid query");
  const date = value.date ? value.date.toISOString().slice(0, 10) : todayStr();

  await sessionService.autoCloseStale();
  const sessions = await sessionService.listForDoctorDate(req.doctorId, date);
  const out = [];
  for (const s of sessions) {
    // Sessions per doctor per day are a handful (one per location), so this is
    // bounded — not the query-in-a-loop the conventions forbid.
    const counts = s.id ? await sessionService.queueCounts(s.id) : {};
    const clinic = await sessionService.clinicOf(s.clinicId);
    out.push(serializeSessionForDoctor(s, counts, clinic));
  }
  return ok(res, out, "Sessions");
});

/** The day's tokens in service order. */
exports.queue = asyncHandler(async (req, res) => {
  await sessionService.ownedSession(req.doctorId, req.params.id);
  const rows = await sessionService.listQueue(req.params.id);
  return ok(res, rows.map(serializeQueueEntry), "Queue");
});

const lifecycle = (fn) =>
  asyncHandler(async (req, res) => {
    const session = await fn(req.doctorId, req.params.id);
    const counts = await sessionService.queueCounts(session.id);
    const clinic = await sessionService.clinicOf(session.clinicId);
    return ok(res, serializeSessionForDoctor(session, counts, clinic), "Session updated");
  });

exports.start = lifecycle(sessionService.start);
exports.pause = lifecycle(sessionService.pause);
exports.resume = lifecycle(sessionService.resume);
exports.end = lifecycle(sessionService.end);

exports.setCap = asyncHandler(async (req, res) => {
  const session = await sessionService.setCap(req.doctorId, req.params.id, req.body.maxBookings);
  const counts = await sessionService.queueCounts(session.id);
  const clinic = await sessionService.clinicOf(session.clinicId);
  return ok(res, serializeSessionForDoctor(session, counts, clinic), "Cap updated");
});

exports.callNext = asyncHandler(async (req, res) => {
  const { session, booking } = await sessionService.callNext(req.doctorId, req.params.id);
  const counts = await sessionService.queueCounts(session.id);
  const clinic = await sessionService.clinicOf(session.clinicId);
  return ok(
    res,
    { session: serializeSessionForDoctor(session, counts, clinic), booking: serializeQueueEntry(booking) },
    "Called in"
  );
});

exports.startConsult = asyncHandler(async (req, res) => {
  const { session, booking } = await sessionService.startConsult(req.doctorId, req.params.id);
  const counts = await sessionService.queueCounts(session.id);
  const clinic = await sessionService.clinicOf(session.clinicId);
  return ok(
    res,
    { session: serializeSessionForDoctor(session, counts, clinic), booking: serializeQueueEntry(booking) },
    "Consultation started"
  );
});

exports.skip = asyncHandler(async (req, res) => {
  const booking = await sessionService.skip(req.doctorId, req.params.id);
  return ok(res, serializeQueueEntry(booking), "Skipped");
});
