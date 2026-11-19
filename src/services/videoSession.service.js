/**
 * Video-consultation feature logic (docs/video-consultation). Owns the join
 * gate, the token mint, and the webhook applier. No LiveKit SDK types leak past
 * this module — it speaks in bookings, sessions, and plain objects.
 *
 * The gate is the one already in production ("own confirmed booking", the same
 * rule clinical-notes / referrals use) PLUS a time window. The token is minted
 * on demand, short-lived, and scoped to exactly one room, so nothing is stored
 * and a leaked token can't reach another consult.
 */
const { Booking, VideoSession, User, ConsultationSession } = require("../models");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");
const livekitService = require("./livekit.service");
const sessionService = require("./session.service");
const {
  ERROR_CODES,
  ROLES,
  BOOKING_STATUS,
  VIDEO_SESSION_STATUS,
  VIDEO_JOIN_LEAD_MINUTES,
  VIDEO_JOIN_GRACE_MINUTES,
  QUEUE_STATE,
} = require("../config/constants");

// The booking columns the gate + token need (no heavy relations).
const JOIN_ATTRS = [
  "id",
  "patientId",
  "doctorId",
  "clinicId",
  // The clinic-portal join gate matches on this (see OWNER_FIELD).
  "bookedByUserId",
  "bookingType",
  "status",
  "slotDate",
  "slotStartTime",
  "slotEndTime",
  // The turn gate reads this — without it every queued patient looks untagged
  // and the gate silently never fires.
  "queueState",
];

/** A video consult = booking_type 'online' AND no clinic (serialized mode === 'video'). */
function isVideoBooking(booking) {
  return booking.bookingType === "online" && booking.clinicId == null;
}

/**
 * Combine a DATEONLY ("YYYY-MM-DD") + a TIME ("HH:mm[:ss]") into a Date in the
 * SERVER's local zone — the exact same interpretation availability.service uses
 * for its "not in the past" check, so the join window and the booking rules
 * agree on what "now" means.
 */
function combineDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${String(timeStr).slice(0, 8)}`);
}

/**
 * The join window: [slotStart − LEAD, slotEnd + GRACE]. Returns
 * `{ ok, reason, secondsLeft }`. `secondsLeft` (≥ 60) bounds the token TTL.
 */
function joinWindow(booking) {
  const start = combineDateTime(booking.slotDate, booking.slotStartTime);
  const end = combineDateTime(booking.slotDate, booking.slotEndTime);
  const opensAt = new Date(start.getTime() - VIDEO_JOIN_LEAD_MINUTES * 60_000);
  const closesAt = new Date(end.getTime() + VIDEO_JOIN_GRACE_MINUTES * 60_000);
  const now = new Date();
  if (now < opensAt) return { ok: false, reason: "too_early" };
  if (now > closesAt) return { ok: false, reason: "closed" };
  return { ok: true, secondsLeft: Math.max(60, Math.floor((closesAt - now) / 1000)) };
}

/**
 * Throw typed errors unless the booking is a joinable video consult right now.
 *
 * `role` matters since the consultation queue: an online session is a queue like
 * any other, so a PATIENT joins when the doctor calls them in, not by the clock.
 * The doctor may always join — they are the one who starts the call, and
 * `call-next` is what sets `serving` in the first place.
 */
function assertJoinable(booking, role) {
  if (!isVideoBooking(booking)) {
    throw new ApiError(400, "This appointment isn't a video consultation", {
      code: ERROR_CODES.VIDEO_NOT_AVAILABLE,
    });
  }
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    throw ApiError.conflict("This consult isn't confirmed yet", {
      code: ERROR_CODES.VIDEO_NOT_AVAILABLE,
    });
  }
  const w = joinWindow(booking);
  if (!w.ok) {
    // Dev testing convenience: don't gate on the clock in development, so a video
    // consult can be joined regardless of when its slot is. The video + confirmed
    // checks above still apply. NEVER relaxed in production.
    if (env.NODE_ENV !== "production") {
      return { ok: true, secondsLeft: 2 * 3600 };
    }
    throw ApiError.forbidden(
      w.reason === "too_early" ? "The call hasn't opened yet" : "The call window has closed",
      { code: ERROR_CODES.VIDEO_WINDOW_CLOSED }
    );
  }
  return w;
}

/**
 * May this patient enter the room right now?
 *
 * The rule is "is the doctor free", NOT "is your token the lowest".
 *
 * That distinction is the whole point. Patient 1 not turning up must never trap
 * patients 2 and 3 behind an empty chair — and a video queue is exactly where
 * that happens, because there is nobody in the corridor for the doctor to look
 * at. So either side may start the consultation: whoever arrives while the
 * doctor is free begins, and the queue records it.
 *
 * What it still prevents is INTERRUPTION. While someone is genuinely being
 * consulted, the next patient waits — otherwise "the doctor is with another
 * patient" would be a lie and two people would land in one room.
 *
 * Bookings made before the queue existed carry no `queue_state` and keep the
 * purely time-based window they were sold with.
 */
async function assertQueueTurn(booking, role) {
  if (role !== ROLES.PATIENT || !booking.queueState) return;
  if (booking.queueState === QUEUE_STATE.SERVING) return;

  const session = booking.sessionId
    ? await ConsultationSession.findByPk(booking.sessionId, { attributes: ["id", "currentBookingId"] })
    : null;
  // No session, or nobody in the chair → the doctor is free. Come in.
  if (!session?.currentBookingId) return;
  if (String(session.currentBookingId) === String(booking.id)) return;

  throw ApiError.conflict("The doctor is with another patient — you'll be called in shortly", {
    code: ERROR_CODES.NOT_YOUR_TURN,
  });
}

/**
 * getOrCreate the pending session row for a booking (idempotent). Called by the
 * payment hook at confirm time AND lazily by the token path, so the row exists
 * exactly once no matter which happens first. `booking` may be a full or a
 * lightweight (JOIN_ATTRS) instance — only `id` is used.
 */
async function getOrCreateSession(booking, tx) {
  const [session] = await VideoSession.findOrCreate({
    where: { bookingId: booking.id },
    defaults: {
      bookingId: booking.id,
      roomName: livekitService.roomName(booking.id),
      status: VIDEO_SESSION_STATUS.PENDING,
    },
    transaction: tx,
  });
  return session;
}

/**
 * Which booking column proves this caller owns this consult.
 *
 * A CLINIC is admitted through `bookedByUserId` — it may join ONLY a call it
 * arranged itself. That is the whole rule: a clinic that did not book this
 * appointment has no column matching its id, so the `findOne` misses and the
 * request 404s, exactly like any other stranger. The patient can still join
 * independently from their own app; nobody is displaced.
 */
const OWNER_FIELD = {
  [ROLES.DOCTOR]: "doctorId",
  [ROLES.PATIENT]: "patientId",
  [ROLES.CLINIC]: "bookedByUserId",
};

const FALLBACK_NAME = {
  [ROLES.DOCTOR]: "Doctor",
  [ROLES.PATIENT]: "Patient",
  [ROLES.CLINIC]: "Clinic",
};

/**
 * The token-endpoint core. Loads the caller's OWN booking (ownership is a WHERE,
 * never a post-load if), gates it, ensures the session row, and mints a token.
 * @param {object} p
 * @param {number|string} p.bookingId
 * @param {number|string} p.actorId  the caller's user id
 * @param {"patient"|"doctor"|"clinic"} p.role
 * @returns {{ url, token, roomName, session }}
 */
async function mintToken({ bookingId, actorId, role }) {
  livekitService.assertEnabled();

  const ownerField = OWNER_FIELD[role];
  if (!ownerField) throw ApiError.forbidden("This account cannot join consultations");

  const booking = await Booking.findOne({
    where: { id: bookingId, [ownerField]: actorId },
    attributes: JOIN_ATTRS,
  });
  if (!booking) throw ApiError.notFound("Booking not found");

  const window = assertJoinable(booking, role);

  /*
   * The DOCTOR opening the call IS starting the consultation.
   *
   * The patient's gate only opens for `serving`, so without this a doctor who
   * navigates straight to a call sits in an empty room while the patient is
   * turned away with "the doctor hasn't called you in yet" — neither of them
   * able to see why. Joining is an unambiguous statement of intent, so the
   * queue follows it rather than demanding a second button first.
   *
   * Never blocks: if another token was mid-consult it goes back to `waiting`,
   * keeping its number and its place.
   */
  await assertQueueTurn(booking, role);

  /*
   * Whoever opened the call starts it — doctor or patient.
   *
   * Symmetric on purpose: the queue should describe who is actually in the
   * room, and it has just been established that this pair may meet. Recording
   * it is also what stops a THIRD patient walking in behind them.
   */
  await sessionService.serveOnJoin(booking);

  const session = await getOrCreateSession(booking);
  const actor = await User.findByPk(actorId, { attributes: ["id", "name"] });

  const token = await livekitService.mintAccessToken({
    room: session.roomName,
    identity: `user:${actorId}`,
    name: actor?.name || FALLBACK_NAME[role],
    metadata: { role, bookingId: String(booking.id) },
    ttlSeconds: window.secondsLeft,
  });

  return { url: livekitService.url(), token, roomName: session.roomName, session };
}

/** Parse the participant metadata we set at mint time back into a role. */
function roleFromMetadata(metadata) {
  try {
    return JSON.parse(metadata || "{}").role || null;
  } catch {
    return null;
  }
}

/**
 * Apply a verified LiveKit webhook event onto the booking's session row.
 * Best-effort + idempotent: unknown events, or events for a room whose session
 * doesn't exist yet (a provisioning race), are silently ignored. One findOne +
 * one save per event — no queries in a loop.
 */
async function applyWebhookEvent(evt) {
  const bookingId = livekitService.bookingIdFromRoom(evt?.room?.name);
  if (!bookingId) return;

  const session = await VideoSession.findOne({ where: { bookingId } });
  if (!session) return;

  switch (evt.event) {
    case "room_started":
      if (!session.startedAt) session.startedAt = new Date();
      if (session.status === VIDEO_SESSION_STATUS.PENDING) session.status = VIDEO_SESSION_STATUS.LIVE;
      break;

    case "participant_joined": {
      const role = roleFromMetadata(evt.participant?.metadata);
      const now = new Date();
      if (role === ROLES.DOCTOR && !session.doctorJoinedAt) session.doctorJoinedAt = now;
      if (role === ROLES.PATIENT && !session.patientJoinedAt) session.patientJoinedAt = now;
      if (!session.startedAt) session.startedAt = now;
      if (session.status === VIDEO_SESSION_STATUS.PENDING) session.status = VIDEO_SESSION_STATUS.LIVE;
      break;
    }

    case "room_finished":
      if (!session.endedAt) session.endedAt = new Date();
      session.status = VIDEO_SESSION_STATUS.ENDED;
      if (session.startedAt && session.durationSec == null) {
        session.durationSec = Math.max(0, Math.floor((session.endedAt - session.startedAt) / 1000));
      }
      break;

    default:
      return; // ignore track_*, egress_*, participant_left, etc.
  }

  await session.save();
}

module.exports = {
  isVideoBooking,
  getOrCreateSession,
  mintToken,
  applyWebhookEvent,
  // exported for unit-level reasoning/tests:
  joinWindow,
  assertJoinable,
};
