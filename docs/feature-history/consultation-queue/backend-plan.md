# Consultation queue — backend plan

🔵 Planned. Follows `backend/` conventions: routes → validators (Joi only) → controllers (thin) →
services (all logic) → serializers. See the `backend-conventions` skill.

---

## 1. Tables

### 1.1 🔵 `consultation_sessions` — one doctor, one place, one day, one window

```sql
CREATE TABLE consultation_sessions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id           BIGINT UNSIGNED NOT NULL,
  clinic_id           BIGINT UNSIGNED NULL,           -- NULL = online / video session
  session_date        DATE            NOT NULL,
  start_time          TIME            NOT NULL,       -- 09:00
  end_time            TIME            NOT NULL,       -- 16:00
  status              ENUM('scheduled','in_progress','paused','completed','cancelled')
                        NOT NULL DEFAULT 'scheduled',
  max_bookings        SMALLINT UNSIGNED NULL,         -- NULL = unlimited (the default)
  next_token          SMALLINT UNSIGNED NOT NULL DEFAULT 1,   -- the allocator, never reused
  current_booking_id  BIGINT UNSIGNED NULL,           -- who the doctor is with RIGHT NOW
  avg_consult_minutes SMALLINT UNSIGNED NULL,         -- rolling, measured; seeds the ETA
  started_at          DATETIME NULL,
  ended_at            DATETIME NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- COALESCE, because MySQL allows unlimited NULLs in a UNIQUE index: without
  -- this, two online sessions on the same date at the same time would NOT collide.
  clinic_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(clinic_id, 0)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_session_slotless (doctor_id, session_date, clinic_key, start_time),
  KEY idx_session_doctor_date (doctor_id, session_date),
  KEY idx_session_status (status),
  CONSTRAINT fk_session_doctor FOREIGN KEY (doctor_id) REFERENCES doctor_profiles (user_id),
  CONSTRAINT fk_session_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **`next_token` is an allocator, not a count.** It only ever goes up. A cancelled `#4` does not
  free the number — the *position* is recomputed instead (§4.2), so tokens stay stable and
  meaningful while the queue still shrinks.
- **`current_booking_id` has no FK** on purpose. `bookings.session_id` already points the other way;
  adding the reverse constraint creates the same cyclic-FK problem
  [`models/index.js:232`](../../../src/models/index.js) documents for `Booking ↔ Referral`, which
  forces Sequelize into an unresolvable sync order.
- **No `capacity` column separate from `max_bookings`** — one nullable number, where NULL means
  unlimited. That is the doctor's actual request, stated in the schema.
- **`avg_consult_minutes` is measured, not configured.** It is recomputed on each completion (§4.3).
  Before any consult finishes it is NULL and the ETA falls back to the weekly template's value.

### 1.2 🟡 `bookings` — six nullable columns

```sql
ALTER TABLE bookings
  ADD COLUMN session_id         BIGINT UNSIGNED NULL AFTER clinic_id,
  ADD COLUMN queue_number       SMALLINT UNSIGNED NULL AFTER session_id,
  ADD COLUMN queue_state        ENUM('waiting','serving','done','skipped') NULL AFTER queue_number,
  ADD COLUMN called_at          DATETIME NULL,
  ADD COLUMN consult_started_at DATETIME NULL,
  ADD COLUMN consult_ended_at   DATETIME NULL,
  ADD KEY idx_booking_session_queue (session_id, queue_number),
  ADD CONSTRAINT fk_booking_session FOREIGN KEY (session_id) REFERENCES consultation_sessions (id);
```

Every column is nullable so **historical rows are untouched**: a booking from before the migration
keeps `session_id NULL` and renders exactly as it does today.

`slot_start_time` / `slot_end_time` **stay NOT NULL and stay written** — they now hold the *session's*
window, the same pair of values for everyone in that session. This is the whole reason the blast
radius is small: `earnings.service`, `treatmentTimeline.service`, `prescription.service`,
`referral.service`, `clinicalNote.service` and `videoSession.service.joinWindow()` keep reading the
fields they already read, unchanged.

### 1.3 🟡 The lock key is re-pointed, not dropped

```sql
-- was: CONCAT(doctor_id,'_',slot_date,'_',slot_start_time)  → one patient per start time
ALTER TABLE bookings DROP INDEX uq_booking_doctor_slot_lock;
ALTER TABLE bookings DROP COLUMN active_lock_key;
ALTER TABLE bookings
  ADD COLUMN active_lock_key VARCHAR(80) GENERATED ALWAYS AS (
      CASE WHEN status IN ('pending_payment','confirmed') AND session_id IS NOT NULL
           THEN CONCAT(session_id, '_', queue_number)
           ELSE NULL END) VIRTUAL,
  ADD UNIQUE KEY uq_booking_session_token (active_lock_key);
```

The guarantee changes from *"two patients can never hold the same start time"* to *"two patients can
never hold the same token"*. It is still the database enforcing it, still `INSERT` and let the loser
lose, still never check-then-insert — the discipline
[`booking.service.js:5-9`](../../../src/services/booking.service.js) states in its header.

`ELSE NULL` covers legacy rows (`session_id IS NULL`), which drop out of the unique index entirely —
MySQL permits unlimited NULLs.

### 1.4 🟡 Weekly templates gain a cap, and one column changes meaning

```sql
ALTER TABLE clinic_availability        ADD COLUMN max_bookings SMALLINT UNSIGNED NULL;
ALTER TABLE doctor_online_availability ADD COLUMN max_bookings SMALLINT UNSIGNED NULL;
```

`slot_duration_minutes` is **kept and reinterpreted**: it stops slicing the window into bookable
times and becomes *expected minutes per patient*, the seed for the ETA. The column is not renamed —
renaming it would touch two models, two validators, three serializers and three frontends for a
cosmetic gain. It is exposed to clients as **`avgConsultMinutes`** at the serializer boundary, and
the model comments say so.

### 1.5 🔵 Migration `027_consultation_sessions.sql`

Idempotent and `information_schema`-guarded, like 013–026. Order matters:

1. `CREATE TABLE IF NOT EXISTS consultation_sessions`.
2. Add the six `bookings` columns + index + FK (guarded).
3. Add `max_bookings` to both availability tables (guarded).
4. **Backfill** (§7) — must run *before* step 5, because the new lock key needs `session_id` and
   `queue_number` populated on every live booking.
5. Drop the old index + generated column, add the new pair (§1.3).

### 1.6 🔵 `db/ensureQueueColumns.js` — the dev-sync parity shim

`sequelize.sync()` cannot express a STORED/VIRTUAL generated column, so on a dev database it will
create `consultation_sessions` without `clinic_key` and leave `bookings.active_lock_key` on the old
expression. This shim mirrors 027 after sync, in the pattern of
[`ensureBookingLockKey.js`](../../../src/db/ensureBookingLockKey.js) and
[`ensureFollowUpColumns.js`](../../../src/db/ensureFollowUpColumns.js) — `information_schema`
probe, early `return false` when already correct, then the ALTERs. Registered in `server.js`
alongside the existing shims.

> **`ensureBookingLockKey.js` must be updated in the same commit.** If it keeps re-adding the old
> `doctor_id_date_start` expression after every dev boot, the cap comes straight back on developer
> machines and nowhere else — the worst possible failure mode.

---

## 2. Models 🔵🟡

`models/consultationSession.model.js` 🔵 — mirrors §1.1. `clinic_key` is **deliberately not
declared**, exactly as `booking.model.js` omits `active_lock_key` and for the same reason (sync would
clobber the generated column with a plain one).

`models/booking.model.js` 🟡 — add the six fields; `activeLockKey` stays undeclared.

`models/index.js` 🟡 — three associations, in the file's existing style:

```js
// A session is a doctor's consulting window at one place on one day; its
// bookings are the queue, ordered by token.
ConsultationSession.hasMany(Booking, { foreignKey: "sessionId", as: "queue" });
Booking.belongsTo(ConsultationSession, { foreignKey: "sessionId", as: "session" });
DoctorProfile.hasMany(ConsultationSession, { foreignKey: "doctorId", as: "sessions" });
Clinic.hasMany(ConsultationSession, { foreignKey: "clinicId", as: "sessions" });
// NOTE: no ConsultationSession.belongsTo(Booking) for current_booking_id — that
// closes a cycle with bookings.session_id and breaks Sequelize's sync ordering,
// the same hazard documented for Booking ↔ Referral above.
```

---

## 3. Constants 🟡 `config/constants.js`

```js
const SESSION_STATUS = Object.freeze({
  SCHEDULED: "scheduled", IN_PROGRESS: "in_progress", PAUSED: "paused",
  COMPLETED: "completed", CANCELLED: "cancelled",
});
const QUEUE_STATE = Object.freeze({
  WAITING: "waiting", SERVING: "serving", DONE: "done", SKIPPED: "skipped",
});
/** Bookings that occupy a place in the queue (and hold a token). */
const LIVE_QUEUE_STATUSES = Object.freeze([BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED]);
/** Client poll cadence for the queue endpoints; the frontends read this from the API. */
const QUEUE_POLL_SECONDS = 20;
/** A session nobody ended is auto-closed this long after its end_time. */
const SESSION_AUTO_CLOSE_HOURS = 6;
/** Fallback when a session has no measured average yet and no template value. */
const DEFAULT_CONSULT_MINUTES = 15;   // reuses SLOT_DEFAULT_MINUTES' value
```

New `ERROR_CODES`: `SESSION_FULL`, `SESSION_CLOSED`, `SESSION_NOT_FOUND`, `NOT_YOUR_TURN`,
`QUEUE_ALREADY_SERVING`. `SLOT_TAKEN` / `SLOT_UNAVAILABLE` stay — they are still what a raced token
insert and a closed/blocked date return, and every client already handles them
(`utils/booking-error.ts` (`frontend-patient/src/utils/booking-error.ts`)).

---

## 4. 🔵 `services/session.service.js` — the new core

### 4.1 `resolveSession({ doctorId, clinicId, dateStr, create })`

The single place a `consultation_sessions` row comes into existence. Lazily materialises the weekly
template for one date:

1. `findOne` by `(doctorId, clinicId, sessionDate, startTime)` → return it if present.
2. Otherwise reuse [`availability.service.resolveWindows()`](../../../src/services/availability.service.js) 🟢
   **unchanged** — it already applies the publicly-listed gate, the `availability_exceptions`
   blocked-date check and the clinic-ownership check, and already returns the raw windows. A blocked
   date returns `[]` → no session → nothing bookable, exactly as today.
3. `create` with `startTime`/`endTime` from the window, `maxBookings` and `avgConsultMinutes` copied
   from the template, `status='scheduled'`.
4. On `SequelizeUniqueConstraintError` (two patients booking the first appointment of a day at the
   same instant), swallow and re-read. The UNIQUE key makes the race harmless.

> A doctor with two windows on one day (Clinic A 9–4, Clinic B 7–9) gets **two session rows**,
> distinguished by `clinic_key` + `start_time`. Two windows for the *same* clinic on one day (a
> morning and an evening OPD) also work — they differ by `start_time`.

### 4.2 `queueView(booking)` — position, ETA, and what the patient sees

One indexed COUNT. Never a query in a loop, never N+1:

```sql
SELECT COUNT(*) AS ahead FROM bookings
 WHERE session_id = :sessionId
   AND queue_state = 'waiting'
   AND status IN ('pending_payment','confirmed')
   AND queue_number < :myToken
```

- **Position = `ahead + 1`.** The token is immutable; the position falls when someone ahead is
  completed (`queue_state → done`), skipped, cancelled, or when their unpaid hold is swept
  ([`expireStaleHolds`](../../../src/services/availability.service.js) 🟡, re-scoped to the
  session). This is precisely the "4 → 3" the doctor described.
- **Unpaid holds DO count as ahead of you.** They hold a token and may still pay. When the hold
  expires the position corrects itself on the next poll.
- **ETA:**
  `estimatedStartAt = base + ahead × avgMinutes`, where `base` is the current consult's
  `consult_started_at` if the doctor is serving someone, else `max(now, session.start_time)`, and
  `avgMinutes` is `session.avg_consult_minutes ?? template ?? DEFAULT_CONSULT_MINUTES`.
  Returned as an ISO instant plus `etaConfidence: 'measured' | 'estimated'` so the UI can say
  *"about"* instead of pretending to precision it does not have.

### 4.3 Session lifecycle

| Function | Effect |
|---|---|
| `start(doctorId, id)` | `scheduled\|paused → in_progress`, stamps `started_at` |
| `pause` / `resume` | `in_progress ↔ paused`. Paused shows patients *"Doctor has stepped away"* |
| `callNext(doctorId, id)` | lowest `queue_number` with `queue_state='waiting'` → `serving`; stamps `called_at` + `consult_started_at`; sets `current_booking_id`. 409 `QUEUE_ALREADY_SERVING` if someone is already being served |
| `startConsult(doctorId, bookingId)` | same, for a specific token (serving out of order) |
| `skip(doctorId, bookingId)` | `waiting\|serving → skipped`, clears `current_booking_id` if it was them. A skipped patient can be re-queued with `callNext` on them specifically |
| `end(doctorId, id)` | `→ completed`, stamps `ended_at`, clears `current_booking_id`. Remaining `waiting` rows are left alone for the doctor to mark no-show |

**Completion is not here** — it stays on `booking.service.complete()` (§5.3), because completing a
consultation already settles cash, closes referrals and writes earnings. The queue is an additional
effect of that one action, not a competing one.

`avg_consult_minutes` is recomputed inside `complete()` with one aggregate over the session's own
finished consults — no counter column to drift:

```sql
SELECT AVG(TIMESTAMPDIFF(MINUTE, consult_started_at, consult_ended_at))
  FROM bookings WHERE session_id = ? AND queue_state = 'done' AND consult_started_at IS NOT NULL
```

Applied only once ≥3 consults have finished; below that the sample is noise and a single 40-minute
first patient would tell everyone else to come back tomorrow.

### 4.4 Auto-close

`session.service.autoCloseStale()` — one UPDATE, called opportunistically from the doctor's session
list and the patient's queue read (the same "sweep on read" pattern as `expireStaleHolds`, so no
cron job is introduced):

```sql
UPDATE consultation_sessions SET status='completed', ended_at=NOW(), current_booking_id=NULL
 WHERE status IN ('in_progress','paused')
   AND TIMESTAMPADD(HOUR, :hours, TIMESTAMP(session_date, end_time)) < NOW()
```

---

## 5. 🟡 Changes to existing services

### 5.1 `availability.service.js`

| Function | Change |
|---|---|
| `expandSlots()` | **deleted** — the only thing that turned a window into discrete times |
| `previewSlots()` | **replaced** by `previewSessions()` (§6.1): windows + live counts, no expansion, no time subtraction |
| `resolveBookableSlot()` | **replaced** by `session.service.resolveSession()` + the token transaction |
| `takenStartTimes()` | **deleted** — nothing is "taken" any more |
| `resolveWindows()` | 🟢 **unchanged and now load-bearing** — every gate (listed, blocked date, clinic ownership) lives here and is inherited for free |
| `expireStaleHolds()` | 🟡 re-scoped from `(doctorId, slotDate)` to `sessionId`, and additionally sets `queue_state=NULL` |
| `set*Availability()` | 🟡 accepts `maxBookings` in the replace-the-set payload |

### 5.2 `booking.service.create()` — the token transaction

The one piece that must be exactly right. Replaces the `resolveBookableSlot` call:

```js
// Lock the session row, allocate inside the lock, insert, bump. Holding the row
// lock is what makes the capacity check safe — a check-then-insert on an
// unlocked row is precisely the race the old slot code avoided by never doing it.
const { booking } = await sequelize.transaction(async (tx) => {
  const session = await ConsultationSession.findByPk(sessionId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!session) throw ApiError.notFound("Session not found", { code: ERROR_CODES.SESSION_NOT_FOUND });
  if (session.status === CANCELLED || session.status === COMPLETED) throw 409 SESSION_CLOSED;
  if (session.maxBookings != null) {
    const live = await Booking.count({ where: { sessionId, status: LIVE_QUEUE_STATUSES }, transaction: tx });
    if (live >= session.maxBookings) throw new ApiError(409, "This session is full", { code: SESSION_FULL });
  }
  const queueNumber = session.nextToken;
  const b = await Booking.create({ ...bookingFields, sessionId, queueNumber, queueState: WAITING,
    slotDate: session.sessionDate, slotStartTime: session.startTime, slotEndTime: session.endTime }, { transaction: tx });
  await session.increment("nextToken", { by: 1, transaction: tx });
  if (referralId) await referralService.linkBooking(b, referralId, tx);
  return { booking: b };
});
```

- The lock is held for one row for well under a millisecond; concurrent bookings on **different**
  sessions never touch each other.
- The `SequelizeUniqueConstraintError → 409 SLOT_TAKEN` catch at
  [`booking.service.js:260`](../../../src/services/booking.service.js) **stays** as the backstop
  and now means "token collision", which should be unreachable.
- Everything downstream is unchanged: the offline/online/dev-bypass payment branches, the Razorpay
  order, `provisionVideoConsult`, the referral link, the `patientService.assertProfileComplete` gate.
- **A past date is rejected** where the old code rejected a past *time*: a session whose
  `end_time` has passed is `SESSION_CLOSED`.

### 5.3 `booking.service.complete()` 🟡

Inside the existing transaction, after the cash settlement and before the referral close, add:
`queue_state='done'`, `consult_ended_at=NOW()`, clear `session.current_booking_id` if it pointed
here, recompute `avg_consult_minutes` (§4.3). A **no-show** sets `queue_state='skipped'` instead —
it collected nothing and must not pollute the average.

### 5.4 `booking.service.reschedule()` 🟡

Body becomes `{ sessionId, reason }` (or `{ date, clinicId }`, resolved through `resolveSession`).
The target session's window overwrites `slot_start_time`/`slot_end_time`, and a **fresh token at the
tail** is allocated through the same locked transaction as §5.2. The old session's
`current_booking_id` is cleared if it pointed at this booking.

> **Fixes a live bug while here.** `reschedule()` references `UniqueConstraintError` without ever
> importing it ([`booking.service.js:489`](../../../src/services/booking.service.js)) — today a
> genuine collision throws `ReferenceError` and 500s instead of returning 409.

### 5.5 `booking.service.listForDoctor()` 🟡

`order` moves from `[[slotDate,'DESC'],[slotStartTime,'DESC']]` to
`[[slotDate,'DESC'],[queueNumber,'ASC']]` — inside a day the queue reads in token order, which is
also service order. The `followUpService.mapForBookings` stitch is untouched.

### 5.6 `videoSession.service.js` 🟡 — one gate, one line

`joinWindow()` 🟢 keeps working with no edit: it already derives from `slotStart`/`slotEnd`, which are
now the session window, so the link opens 10 min before the session and closes 30 min after it.
The addition is a **turn gate** in `mintToken`:

```js
// The patient joins when the doctor calls them, not by the clock. The doctor may
// always join — they are the one who starts the call.
if (role === ROLES.PATIENT && booking.queueState !== QUEUE_STATE.SERVING) {
  throw new ApiError(409, "The doctor hasn't called you in yet", { code: ERROR_CODES.NOT_YOUR_TURN });
}
```

Legacy bookings (`session_id IS NULL`, `queue_state IS NULL`) skip the gate and keep the old
time-based behaviour.

---

## 6. Endpoints

### 6.1 🔵 `GET /doctors/:id/sessions` — replaces `GET /doctors/:id/slots`

Public, no auth, same place in [`doctorsPublic.routes.js`](../../../src/routes/doctorsPublic.routes.js).
Query `?mode=clinic|online&clinicId=&from=&to=` (from/to default today → +30 days, capped at 60).

```json
{ "success": true, "data": { "doctorId": "12", "mode": "clinic", "clinicId": "3",
  "sessions": [
    { "sessionId": "88", "date": "2026-08-06", "startTime": "09:00", "endTime": "16:00",
      "booked": 12, "maxBookings": null, "isFull": false, "nextToken": 13,
      "avgConsultMinutes": 12, "status": "scheduled" },
    { "sessionId": null, "date": "2026-08-07", "startTime": "09:00", "endTime": "16:00",
      "booked": 0, "maxBookings": 30, "isFull": false, "nextToken": 1,
      "avgConsultMinutes": null, "status": "scheduled" }
  ] } }
```

`sessionId: null` = the template exists for that date but no row has been materialised yet (nobody
has booked). The client sends the **date**, not the id, and the service materialises on write —
so a stale id can never be booked into.

Counts come from ONE grouped query over the whole range, never per-date:
`SELECT session_id, COUNT(*) … WHERE session_id IN (…) AND status IN (live) GROUP BY session_id`.

`GET /doctors/:id/slots` is **deleted**, along with `slotQuery` in
[`clinic.validator.js`](../../../src/validators/clinic.validator.js) and its `swagger.js` entry.

### 6.2 🟡 `POST /patient/bookings`

`startTime` is removed from `createBooking`. Everything else — `doctorId`, `mode`, `clinicId`,
`date`, `paymentMode`, `referralId` — is unchanged. Response gains `queueNumber` and `session`.

### 6.3 🔵 `GET /patient/bookings/:id/queue`

The polled endpoint. Owner-scoped, cheap, no includes:

```json
{ "success": true, "data": {
  "bookingId": "451", "token": 6, "position": 4, "aheadOfMe": 3,
  "queueState": "waiting", "sessionStatus": "in_progress",
  "doctorBusy": true, "nowServing": 2,
  "estimatedStartAt": "2026-08-06T05:10:00.000Z", "etaConfidence": "measured",
  "canJoinCall": false, "pollSeconds": 20 } }
```

`nowServing` is the **token** of `current_booking_id`, never the other patient's name or id — a
waiting patient learns their place, not who else is in the clinic.

### 6.4 🔵 Doctor session endpoints

Mounted in [`doctorBooking.routes.js`](../../../src/routes/doctorBooking.routes.js) behind the
existing `authenticate + authorize('doctor') + resolveDoctorId('self')` guard.

| Verb | Path | Body | Returns |
|---|---|---|---|
| GET | `/doctor/sessions?date=` | — | today's sessions + `{ waiting, done, skipped, serving }` counts |
| GET | `/doctor/sessions/:id/queue` | — | the ordered token list with patient minis |
| POST | `/doctor/sessions/:id/start` | — | session |
| POST | `/doctor/sessions/:id/pause` \| `/resume` | — | session |
| POST | `/doctor/sessions/:id/end` | — | session |
| POST | `/doctor/sessions/:id/call-next` | — | `{ session, booking }` |
| PATCH | `/doctor/sessions/:id` | `{ maxBookings }` | cap today only, without touching the weekly template |
| POST | `/doctor/bookings/:id/start-consult` | — | booking |
| POST | `/doctor/bookings/:id/skip` | `{ reason? }` | booking |

`POST /doctor/bookings/:id/complete` 🟡 and `/reschedule` 🟡 keep their paths; only their behaviour
and (for reschedule) their body change.

---

## 7. Backfill

Runs inside migration 027, between the column adds and the lock-key swap. Historical rows
(`completed`, `cancelled`, `no_show`) are **left alone** — they keep `session_id NULL`.

```sql
-- 1. One session per (doctor, clinic, date) that has a LIVE booking. The window
--    is the min/max of what those bookings already occupy, so nobody's
--    appointment moves outside the hours they were told.
INSERT INTO consultation_sessions (doctor_id, clinic_id, session_date, start_time, end_time, status, next_token)
SELECT b.doctor_id, b.clinic_id, b.slot_date, MIN(b.slot_start_time), MAX(b.slot_end_time),
       'scheduled', COUNT(*) + 1
  FROM bookings b
 WHERE b.status IN ('pending_payment','confirmed') AND b.session_id IS NULL
 GROUP BY b.doctor_id, b.clinic_id, b.slot_date;

-- 2. Attach each booking + assign tokens in the order patients were originally
--    given: earliest appointment = token 1.
UPDATE bookings b JOIN consultation_sessions s
    ON s.doctor_id = b.doctor_id AND s.session_date = b.slot_date
   AND COALESCE(s.clinic_id,0) = COALESCE(b.clinic_id,0)
   SET b.session_id = s.id, b.queue_state = 'waiting'
 WHERE b.status IN ('pending_payment','confirmed') AND b.session_id IS NULL;
-- queue_number via a windowed UPDATE (ROW_NUMBER() OVER (PARTITION BY session_id
-- ORDER BY slot_start_time, id)) — MySQL 8, which migration 005's generated
-- columns already require.

-- 3. Widen each session to the doctor's actual published window where one exists,
--    so the backfilled 15-minute window becomes the real 9–4.
```

**Pre-flight check** (in the runbook, not the migration): count live bookings whose
`(doctor, clinic, date)` group spans more than one weekly window. Those need a human decision about
which session they belong to; the plan expects zero on the current dataset.

---

## 8. Serializers 🟡 `utils/serializers.js`

- `serializeBookingForPatient` / `…ForDoctor` gain
  `queueNumber`, `queueState`, and `session: { id, startTime, endTime, status }`.
  `date`, `startTime`, `endTime`, `status`, `amount` keep their exact current meaning and shape, so
  every existing consumer keeps working.
- 🔵 `serializeSessionPublic` (§6.1), `serializeQueueView` (§6.3), `serializeSessionForDoctor` (§6.4).
- 🟡 the availability serializer emits `avgConsultMinutes` (from `slot_duration_minutes`) and
  `maxBookings`.

---

## 9. What is NOT touched

`payment.service`, `earnings.service`, `treatmentTimeline.service`, `prescription.service`,
`referral.service`, `clinicalNote.service`, `followUp.service`, `dashboard.service`,
`livekit.service`, the Razorpay webhook and the LiveKit webhook — all read `slot_date` /
`slot_start_time` / `status`, which keep their shape and meaning. That is the payoff of §1.2.
