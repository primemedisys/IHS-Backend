# Backend Plan — Video Consultation (LiveKit)

**App:** `backend/` (Express 5 · Sequelize 6 · MySQL). **Legend:** 🟢 existed · 🟡 extended · 🔵 new.

Layering is unchanged: routes → thin controllers (`asyncHandler`) → services (all business logic) →
models, with a serializer boundary out. Ownership is always a `where:{ id, patientId|doctorId }` in the
service, never a post-load `if`. Every response uses `ok/created` (`{success,message,data}`) or the
central error handler (`{error:{message,code}}`). All new work is confined to migration `012`, two
services, a webhook, and small edits to the booking controllers/routes/serializers + the `confirmPaid` hook.

---

## 1. `package.json` (🟡)

Add one dependency:

```jsonc
"livekit-server-sdk": "^2"   // AccessToken minting + WebhookReceiver (verify) + room name helper
```

CommonJS-compatible. No other runtime dep is needed (no socket server — LiveKit Cloud runs the SFU +
signaling; the backend only mints tokens over REST and receives webhooks).

## 2. `config/env.js` (🟡) + `.env.example` (🟡)

Add a LiveKit block using the **exact** `RAZORPAY_*` idiom — required-non-empty in production, blank in
dev so the rest of the API boots while video stays disabled:

```js
// ── LiveKit (video consultation) ─────────────────────────
// Required (non-empty) in production; blank in dev keeps everything else working
// while video calls stay disabled until Cloud keys are added. LIVEKIT_URL is the
// ONLY value ever sent to the client (public wss:// SFU URL); the SECRET is server-only.
LIVEKIT_URL: Joi.string().when("NODE_ENV", {
  is: "production", then: Joi.string().uri({ scheme: ["ws", "wss"] }).required(),
  otherwise: Joi.string().allow("").default(""),
}),
LIVEKIT_API_KEY: Joi.string().when("NODE_ENV", {
  is: "production", then: Joi.string().min(1).required(),
  otherwise: Joi.string().allow("").default(""),
}),
LIVEKIT_API_SECRET: Joi.string().when("NODE_ENV", {
  is: "production", then: Joi.string().min(1).required(),
  otherwise: Joi.string().allow("").default(""),
}),
```

`.env.example` gets a matching commented block with **placeholders** (never the real secret):

```dotenv
# ── LiveKit (video consultation) ──────────────────────────
# From your LiveKit Cloud project. LIVEKIT_URL is public; the API secret is server-only.
LIVEKIT_URL=wss://<your-project>.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

The real Cloud credentials (held in the harness plan file) go into `backend/.env` at implementation.

## 3. `config/constants.js` (🟡)

```js
/** video_sessions.status lifecycle (mirrors the DB enum). */
const VIDEO_SESSION_STATUS = Object.freeze({ PENDING: "pending", LIVE: "live", ENDED: "ended" });

/** Join window: open 10 min BEFORE the slot, close 30 min AFTER the slot end. */
const VIDEO_JOIN_LEAD_MINUTES  = 10;
const VIDEO_JOIN_GRACE_MINUTES = 30;

// ERROR_CODES additions (docs-shared/feature-plans/video-consultation):
VIDEO_NOT_AVAILABLE:   "VIDEO_NOT_AVAILABLE",   // not a video booking, or not confirmed
VIDEO_WINDOW_CLOSED:   "VIDEO_WINDOW_CLOSED",   // outside the join window
VIDEO_NOT_CONFIGURED:  "VIDEO_NOT_CONFIGURED",  // LiveKit keys absent (503)
```

Export the two new frozen values alongside the existing ones.

## 4. `db/migrations/012_video_sessions.sql` (🔵)

```sql
-- ── 22. VIDEO SESSIONS  ==>  (1:1 booking) the runtime lifecycle of a video consult ──
CREATE TABLE IF NOT EXISTS video_sessions (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id        BIGINT UNSIGNED NOT NULL,                 -- bookings.id (1:1)
    room_name         VARCHAR(120) NOT NULL,                    -- "consult-<bookingId>" (deterministic)
    status            ENUM('pending','live','ended') NOT NULL DEFAULT 'pending',
    started_at        DATETIME NULL,                            -- first room_started webhook
    ended_at          DATETIME NULL,                            -- room_finished webhook
    duration_sec      INT UNSIGNED NULL,                        -- ended_at - started_at (recorded, not derived)
    doctor_joined_at  DATETIME NULL,                            -- participant_joined (identity role=doctor)
    patient_joined_at DATETIME NULL,                            -- participant_joined (identity role=patient)
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_video_sessions_booking (booking_id),          -- strictly 0/1 per booking
    CONSTRAINT fk_video_session_booking FOREIGN KEY (booking_id)
        REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```

**Runner.** `db/migrate.js` tracks applied files in `_migrations`, so `npm run migrate` applies **only
012**. `CREATE TABLE IF NOT EXISTS` makes a re-run a no-op (mirrors the earlier idempotent migrations).

## 5. No boot shim needed (unlike the ALTER-based features)

**Decided during build:** `video_sessions` is a **brand-new table that has a model**, so no
`ensureVideoSessions` shim is written and `server.js` is untouched. The dev boot's `sequelize.sync()`
creates the table (and, via the association, its `booking_id`) automatically; production gets it from
migration `012`. This is exactly how `care_journeys` / `referrals` are handled — the ensure-shims
(`ensureBookingLockKey`, `ensurePatientProfileColumns`, `ensureReferralColumns`, …) exist only for
things `sync()` **can't** express: generated columns, `ALTER`s that add columns to an *existing* table,
or tables with no model (`rx_counters`). None of those apply here, so adding a shim would be dead code.
*(On the shared dev DB the migration runner is currently blocked on a pre-existing, unrelated `011`
failure; the table was created via `VideoSession.sync()` + a guarded FK add, which matches this migration
byte-for-byte.)*

## 6. `models/videoSession.model.js` (🔵) + `models/index.js` (🟡)

**`models/videoSession.model.js`**
```js
sequelize.define("VideoSession", {
  bookingId, roomName, status,            // status default VIDEO_SESSION_STATUS.PENDING
  startedAt, endedAt, durationSec,
  doctorJoinedAt, patientJoinedAt,
}, { tableName: "video_sessions", underscored: true });
```
Global `underscored: true` maps `roomName → room_name`, `doctorJoinedAt → doctor_joined_at`, etc.

**`models/index.js`** (🟡)
```js
// A booking has at most one video session (video consults only).
Booking.hasOne(VideoSession, { foreignKey: "bookingId", as: "videoSession", onDelete: "CASCADE" });
VideoSession.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
```
Plus the `require` and the `module.exports` addition (`VideoSession`).

## 7. `services/livekit.service.js` (🔵) — the LiveKit adapter

The only module that talks to the SDK. Lazy + gracefully-disabled (mirrors `paymentService.getClient()`
throwing a clean 503 when keys are absent — never crash the boot).

```js
const { AccessToken, WebhookReceiver } = require("livekit-server-sdk");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

function isEnabled() {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}
function assertEnabled() {
  if (!isEnabled())
    throw new ApiError(503, "Video is not configured", { code: ERROR_CODES.VIDEO_NOT_CONFIGURED });
}

/** Deterministic, unstored — always derivable from the booking id. */
function roomName(bookingId) { return `consult-${bookingId}`; }

/**
 * Mint a short-lived room-scoped join token.
 * identity: "user:<id>"; metadata carries the role; ttl bounded by the join window.
 */
async function mintAccessToken({ room, identity, name, metadata, ttlSeconds }) {
  assertEnabled();
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity, name, metadata: JSON.stringify(metadata ?? {}), ttl: ttlSeconds,
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();          // string JWT — the ONLY LiveKit credential the client ever sees
}

/** Verify + parse an inbound webhook. `authHeader` = the request's Authorization; `body` = raw string. */
async function receiveWebhook(body, authHeader) {
  assertEnabled();
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return receiver.receive(body, authHeader);   // throws on bad signature
}

module.exports = { isEnabled, assertEnabled, roomName, mintAccessToken, receiveWebhook, URL: () => env.LIVEKIT_URL };
```

> **Note:** in `livekit-server-sdk` v2 `AccessToken#toJwt()` is async — `await` it. `WebhookReceiver#receive`
> validates the JWT `Authorization` header LiveKit sends and returns a typed `WebhookEvent`.

## 8. `services/videoSession.service.js` (🔵) — the feature logic

The join gate + the token mint + the webhook applier. No LiveKit SDK types leak past here.

```js
const UNLOCKED = BOOKING_STATUS.CONFIRMED;         // only a confirmed booking may call

/** True video consult = booking_type 'online' AND clinic_id NULL (serialized mode === 'video'). */
function isVideoBooking(b) { return b.bookingType === "online" && b.clinicId == null; }

/** Join window: [slotStart - LEAD, slotEnd + GRACE]. Returns { ok, reason, secondsLeft }. */
function joinWindow(booking) {
  const start = combineDateTime(booking.slotDate, booking.slotStartTime); // IST-safe, like availability.service
  const end   = combineDateTime(booking.slotDate, booking.slotEndTime);
  const opens  = subMinutes(start, VIDEO_JOIN_LEAD_MINUTES);
  const closes = addMinutes(end,   VIDEO_JOIN_GRACE_MINUTES);
  const now = new Date();
  if (now < opens)  return { ok: false, reason: "too_early", secondsLeft: 0 };
  if (now > closes) return { ok: false, reason: "closed",    secondsLeft: 0 };
  return { ok: true, secondsLeft: Math.max(60, Math.floor((closes - now) / 1000)) };
}

/** Throws typed errors; returns the window when joinable. */
function assertJoinable(booking) {
  if (!isVideoBooking(booking) || booking.status !== UNLOCKED)
    throw new ApiError(booking.status !== UNLOCKED ? 409 : 400, "This isn't a joinable video consult",
      { code: ERROR_CODES.VIDEO_NOT_AVAILABLE });
  const w = joinWindow(booking);
  if (!w.ok)
    throw new ApiError(403, w.reason === "too_early"
      ? "The call hasn't opened yet" : "The call window has closed",
      { code: ERROR_CODES.VIDEO_WINDOW_CLOSED });
  return w;
}

/** getOrCreate the pending session row (idempotent; used by confirmPaid AND first token/webhook). */
async function getOrCreateSession(booking, tx) {
  const room = livekitService.roomName(booking.id);
  const [session] = await VideoSession.findOrCreate({
    where: { bookingId: booking.id },
    defaults: { bookingId: booking.id, roomName: room, status: VIDEO_SESSION_STATUS.PENDING },
    transaction: tx,
  });
  return session;
}

/** The token endpoint core. `role` ∈ {'patient','doctor'}. */
async function tokenFor(booking, user, role) {
  livekitService.assertEnabled();
  const window = assertJoinable(booking);
  const session = await getOrCreateSession(booking);
  const room = session.roomName;
  const token = await livekitService.mintAccessToken({
    room, identity: `user:${user.id}`, name: user.name, metadata: { role, bookingId: String(booking.id) },
    ttlSeconds: window.secondsLeft,
  });
  return { url: livekitService.URL(), token, roomName: room, session };
}

/** Webhook applier — best-effort, idempotent. Maps a LiveKit event onto the session row. */
async function applyWebhookEvent(evt) {
  const bookingId = bookingIdFromRoom(evt.room?.name);   // "consult-<id>" → id
  if (!bookingId) return;
  const session = await VideoSession.findOne({ where: { bookingId } });
  if (!session) return;                                   // provisioning race — ignore
  switch (evt.event) {
    case "room_started":
      if (!session.startedAt) { session.startedAt = new Date(); session.status = VIDEO_SESSION_STATUS.LIVE; }
      break;
    case "participant_joined": {
      const role = roleFromMetadata(evt.participant?.metadata);      // 'doctor' | 'patient'
      if (role === "doctor"  && !session.doctorJoinedAt)  session.doctorJoinedAt  = new Date();
      if (role === "patient" && !session.patientJoinedAt) session.patientJoinedAt = new Date();
      if (session.status === VIDEO_SESSION_STATUS.PENDING) session.status = VIDEO_SESSION_STATUS.LIVE;
      break;
    }
    case "room_finished":
      session.endedAt = new Date();
      session.status = VIDEO_SESSION_STATUS.ENDED;
      if (session.startedAt) session.durationSec = Math.floor((session.endedAt - session.startedAt) / 1000);
      break;
    default: return;                                       // ignore track_* etc.
  }
  await session.save();
}
```

**No queries in loops** (backend-conventions): webhook handling is one `findOne` + one `save` per event.
`combineDateTime`/IST handling reuses the same approach `availability.service` already uses for slots.

## 9. `services/payment.service.js` (🟡) — the provisioning hook

The one change to the existing confirm path, at the reserved line in `confirmPaid()` (currently the
`// Hook: video → generateMeetLink(booking)` comment). After the booking is `confirmed`:

```js
// Hook: provision the video consult (idempotent; no-op for clinic bookings / when LiveKit is off).
if (livekitService.isEnabled() && videoSessionService.isVideoBooking(booking)) {
  booking.meetLink = `${patientBaseUrl()}/dashboard/appointments/${booking.id}/call`;
  await booking.save();                              // serializeBookingForPatient already emits meetLink
  await videoSessionService.getOrCreateSession(booking);  // status = pending
}
```

- `patientBaseUrl()` = the patient origin from `env.CLIENT_URL` (the comma-separated list; take the
  patient entry, or add `PATIENT_URL` to env if the list order isn't reliable — a one-line env add).
- **Absent LiveKit config or a clinic booking → skipped**, so behaviour is byte-for-byte today's
  (`meetLink` stays null). Not wrapped in the confirm transaction: a provisioning hiccup must never
  fail a payment — the token endpoint's `getOrCreateSession` re-creates the row lazily anyway.

## 10. Controllers (🟡🔵)

**`controllers/booking.controller.js`** (🟡, patient) + **`controllers/doctorBooking.controller.js`**
(🟡, doctor) each gain a thin `videoToken`:
```js
// patient: req.user.id ; doctor: req.doctorId — both scope ownership in the service read
const booking = await bookingService.getOwnedBookingEntity(actorId, req.params.id); // where:{id, patientId|doctorId}
const result  = await videoSessionService.tokenFor(booking, req.user, ROLE);
return ok(res, serializeVideoToken(result));
```
(`getOwnedBookingEntity` is the existing owned-lookup the services already do for `getForPatient` /
`getForDoctor…`; expose the entity for the token path, or fetch inside `tokenFor`.)

**`controllers/videoWebhook.controller.js`** (🔵)
```js
async function receive(req, res) {
  try {
    const evt = await livekitService.receiveWebhook(req.rawBody, req.headers.authorization);
    await videoSessionService.applyWebhookEvent(evt);
  } catch (e) { logger.warn("livekit webhook", e); }     // best-effort — never surface to LiveKit
  return res.status(200).end();                          // always 200 so LiveKit doesn't retry-storm
}
```

## 11. Routes (🟡)

```js
// routes/patient.routes.js  (guard = [authenticate, authorize('patient')])
router.post("/bookings/:id/video-token", ...guard, booking.videoToken);

// routes/doctorBooking.routes.js  (guard = [authenticate, authorize('doctor'), resolveDoctorId('self')])
router.post("/bookings/:id/video-token", ...guard, doctorBooking.videoToken);

// routes/webhook.routes.js  (raw-body path, next to the Razorpay webhook — NO auth middleware;
//                            LiveKit signs the payload, verified in the controller)
router.post("/livekit", videoWebhook.receive);
```

`app.js` (🟡) — the webhook mount must receive the **raw body** (the same `express.raw`/`rawBody`
capture the Razorpay webhook already uses), because `WebhookReceiver.receive` verifies over the exact bytes.

## 12. `utils/serializers.js` (🟡)

```js
serializeVideoSession(s) → {
  status, roomName, startedAt, endedAt, durationSec,
  doctorJoined:  Boolean(s.doctorJoinedAt),
  patientJoined: Boolean(s.patientJoinedAt),
}
serializeVideoToken({ url, token, roomName, session }) → {
  url, token, roomName, session: session ? serializeVideoSession(session) : null,
}
```
And extend **`serializeBookingForDoctor`** (🟡) to emit `meetLink: b.meetLink ?? null` and
`videoSession: b.videoSession ? serializeVideoSession(b.videoSession) : null` (the patient serializer
already emits `meetLink`; add `videoSession` there too if the patient card wants "doctor is here" state).
Only the token + public URL + room name ever leave the server — **never** the API key/secret
(same discipline as `serializeRazorpayOrder` sending only the public `keyId`).

## 13. Why these choices (design decisions in one place)

- **A `video_sessions` table, not columns on `bookings`.** The call is a runtime event with its own
  lifecycle from an external system; keeping it 1:1 and separate leaves the hot booking row untouched and
  matches the codebase's first-class-table habit (`payments`, `referrals`).
- **Deterministic, unstored room name.** `consult-<bookingId>` can't drift and needs no allocation step;
  LiveKit auto-creates the room on first join.
- **Tokens minted on demand, short-lived, room-scoped.** Nothing to store or leak; a token authorizes
  exactly one room for exactly the remaining window.
- **The gate is the one already in production.** "Own confirmed booking" (the same rule `clinical_notes`
  and `referrals` use) plus a time window — no new authorization primitive.
- **Webhook = audit only; presence = client.** The live experience never waits on our DB, so a webhook
  delay or miss degrades gracefully (the call still works; only the audit row lags).
- **Graceful "not configured".** `isEnabled()`/503 mirrors `paymentService.getClient()` — dev boots with
  blank keys, video simply stays off, everything else works.
