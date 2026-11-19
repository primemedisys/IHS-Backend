# Follow-up reminders — backend plan

🔵 Planned. Follows `backend/` conventions: routes → validators (Joi only) → controllers (thin) →
services (all logic) → serializers. See the `backend-conventions` skill.

---

## 1. Tables

### 1.1 🔵 `follow_up_reminders` — the reminder schedule

```sql
CREATE TABLE follow_up_reminders (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id     BIGINT UNSIGNED NOT NULL,       -- the consultation this reminder belongs to
  doctor_id      BIGINT UNSIGNED NOT NULL,       -- denormalized for fast roster queries
  patient_id     BIGINT UNSIGNED NOT NULL,       -- denormalized for fast patient-dashboard queries
  clinic_id      BIGINT UNSIGNED NULL,           -- nullable for video consults
  follow_up_on   DATE         NOT NULL,           -- the expected-back date (copied from patient_follow_ups)
  reminder_at    DATETIME     NOT NULL,           -- when to trigger (computed: follow_up_on - interval)
  channel        ENUM('email','whatsapp','both') NOT NULL DEFAULT 'both',
  status         ENUM('pending','processing','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
  email_status   ENUM('pending','sent','failed')  NOT NULL DEFAULT 'pending',
  whatsapp_status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  retry_count    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_retries    TINYINT UNSIGNED NOT NULL DEFAULT 3,
  last_error     TEXT         NULL,
  sent_at        DATETIME     NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fur_doctor   (doctor_id, status),
  KEY idx_fur_patient  (patient_id, status),
  KEY idx_fur_schedule (status, reminder_at),
  CONSTRAINT fk_fur_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_fur_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fur_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fur_clinic  FOREIGN KEY (clinic_id)  REFERENCES clinics (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Why `reminder_at` is a DATETIME, not an offset:** The scheduler queries `WHERE status = 'pending'
AND reminder_at <= NOW()`. A DATETIME is directly comparable — no date arithmetic at query time.
The DATETIME is computed once when the doctor saves the reminder and stored permanently.

**Why `email_status` and `whatsapp_status` are separate:** A partial failure (email sent, WhatsApp
failed) must be trackable. Marking the whole row `sent` when one channel failed would be misleading.

**Why `booking_id` is the FK, not `patient_follow_ups`:** The booking already links to doctor,
patient, clinic, and date. Adding a FK to `patient_follow_ups` would create a circular dependency
(patient_follow_ups.booking_id → bookings.id → follow_up_reminders.booking_id →
patient_follow_ups). The booking is the natural anchor.

### 1.2 🟡 `patient_profiles` — WhatsApp opt-in column

```sql
ALTER TABLE patient_profiles
  ADD COLUMN whatsapp_opt_in TINYINT(1) NOT NULL DEFAULT 0
  AFTER no_current_medications;
```

One boolean. Default `0` (not opted in). The patient explicitly enables it from their settings.
The WhatsApp provider checks this flag before every send.

### 1.3 Migration `029_follow_up_reminders.sql`

Idempotent and information_schema-guarded, like 013–028:

1. Create `follow_up_reminders` table.
2. Add `whatsapp_opt_in` column to `patient_profiles`.

No backfill needed — existing follow-ups have no reminder configuration, which is correct.

---

## 2. Models

🔵 `models/followUpReminder.model.js`, registered in `models/index.js` with:

```js
FollowUpReminder.belongsTo(Booking, { as: "booking", foreignKey: "bookingId" });
FollowUpReminder.belongsTo(User, { as: "doctor", foreignKey: "doctorId" });
FollowUpReminder.belongsTo(User, { as: "patient", foreignKey: "patientId" });
FollowUpReminder.belongsTo(Clinic, { as: "clinic", foreignKey: "clinicId" });

Booking.hasMany(FollowUpReminder, { as: "reminders", foreignKey: "bookingId" });
```

🟡 `patientProfile.model.js` — add `whatsappOptIn` field.

---

## 3. Constants

🔵 `config/constants.js` — new entries:

```js
const REMINDER_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const REMINDER_CHANNEL = Object.freeze({
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  BOTH: "both",
});

const CHANNEL_STATUS = Object.freeze({
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
});

/** How many minutes before follow_up_on to trigger the reminder by default. */
const DEFAULT_REMINDER_DAYS_BEFORE = 3;

/** Maximum delivery retries before marking a channel as failed. */
const MAX_REMINDER_RETRIES = 3;

/** How often the scheduler queries for due reminders (milliseconds). */
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
```

---

## 4. Endpoints

### 4.1 Doctor endpoints (under `/doctor`, guarded by existing middleware)

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | `GET` | `/bookings/:id/reminder` | Get this consultation's reminder config |
| 2 | `PUT` | `/bookings/:id/reminder` | Create or update reminder config |
| 3 | `DELETE` | `/bookings/:id/reminder` | Cancel the reminder |

### 4.2 Patient endpoints (under `/patient`, guarded by existing patient auth)

| # | Method | Path | Purpose |
|---|---|---|---|
| 4 | `GET` | `/follow-ups/upcoming` | List upcoming follow-ups with reminder status |
| 5 | `PATCH` | `/profile/whatsapp-opt-in` | Toggle WhatsApp consent |

### 4.3 Internal (no auth — scheduler only, called from within the process)

No HTTP endpoint. The scheduler runs as an in-process cron job (see §6).

### 4.4 Validators (`validators/followUpReminder.validator.js`)

```js
const setReminder = Joi.object({
  reminderDaysBefore: Joi.number().integer().min(1).max(90).allow(null),
  reminderAt: Joi.date().iso().allow(null),
  channel: Joi.string().valid("email", "whatsapp", "both").allow(null),
}).min(1);

const toggleWhatsAppOptIn = Joi.object({
  whatsappOptIn: Joi.boolean().required(),
});
```

The doctor can provide EITHER `reminderDaysBefore` (system computes the DATETIME) OR `reminderAt`
(explicit datetime). At least one must be present.

---

## 5. Services

### 5.1 🔵 `followUpReminder.service.js`

Core responsibilities:
- **Create/update reminder:** When the doctor saves a reminder config, compute `reminder_at` from
  `follow_up_on - reminderDaysBefore` and upsert into `follow_up_reminders`. One reminder per
  booking (PK on `booking_id`).
- **Cancel reminder:** Set `status = 'cancelled'` when the doctor removes the reminder, or when
  the follow-up is cleared.
- **Get reminder for booking:** Return the current reminder config for the appointment detail view.
- **List upcoming for patient:** Query `follow_up_reminders` where `patient_id = ? AND status IN
  ('pending','sent') AND follow_up_on >= CURDATE()`, joined with booking → doctor → clinic.

### 5.2 🔵 `reminderScheduler.service.js`

A self-contained scheduler that runs inside the backend process:

```
┌─────────────────────────────────────────────────────┐
│ reminderScheduler.start()                           │
│                                                     │
│ Every SCHEDULER_INTERVAL_MS:                        │
│   1. SELECT ... FROM follow_up_reminders            │
│      WHERE status = 'pending'                       │
│        AND reminder_at <= NOW()                     │
│      LIMIT 50                                       │
│      FOR UPDATE SKIP LOCKED                         │
│                                                     │
│   2. For each row:                                  │
│      a. SET status = 'processing'                   │
│      b. Dispatch via reminderService.send(row)      │
│      c. On success: status = 'sent', sent_at = NOW()│
│      d. On failure: retry_count++, last_error = ... │
│         If retry_count >= max_retries: status = 'failed' │
│         Else: status = 'pending' (will retry next cycle) │
│                                                     │
│   3. Release lock (SKIP LOCKED handles concurrency) │
└─────────────────────────────────────────────────────┘
```

**Concurrency safety:** `FOR UPDATE SKIP LOCKED` ensures that if two backend instances run (e.g.
during a rolling deploy), each row is claimed by exactly one instance. The other instance skips it.
No duplicate sends.

**Survives restart:** The scheduler is purely DB-driven. A pending reminder with `reminder_at` in
the future simply waits until the next scheduler tick after restart.

**Start/stop:** `reminderScheduler.start()` is called from `server.js` after the DB connection is
established. `reminderScheduler.stop()` is called on SIGTERM/SIGINT for graceful shutdown.

### 5.3 🔵 `notificationService.js` — channel abstraction

```
notificationService.send(reminder)
  ├── emailProvider.send(reminder)    → mail.service.js
  └── whatsappProvider.send(reminder) → whatsapp.service.js
```

Each provider is called independently. The service collects results and returns a composite status.

### 5.4 🟡 `mail.service.js` — extended

Add `sendFollowUpReminder(user, { doctorName, followUpDate, clinicName })`:

- Template: `templates/emails/follow-up-reminder.html`
- Subject: "Reminder: Your follow-up with Dr. {doctorName}"
- Content: patient name, doctor name, follow-up date, clinic name. No medical info.
- Reuses existing nodemailer transport and Ethereal dev fallback.

### 5.5 🔵 `whatsapp.service.js` — Twilio WhatsApp Business

Abstraction layer:

```js
const env = require("../config/env");

async function sendWhatsApp({ to, templateSid, templateParams }) {
  if (env.WHATSAPP_PROVIDER !== "twilio" || !env.TWILIO_ACCOUNT_SID) {
    console.log("📱 WhatsApp (mock):", to, templateSid, templateParams);
    return { ok: true, mock: true };
  }

  const client = require("twilio")(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const msg = await client.messages.create({
    from: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
    to: `whatsapp:${to}`,
    contentSid: templateSid,
    contentVariables: JSON.stringify(templateParams),
  });
  return { ok: true, sid: msg.sid };
}
```

**Mock mode:** When `WHATSAPP_PROVIDER` is not `twilio` (or credentials are missing), the function
logs the message and returns success. This allows full local development without Twilio credentials.

**Template:** Business-initiated WhatsApp messages require an approved template. The template SID is
configured via `TWILIO_CONTENT_TEMPLATE_SID`. Template parameters are passed as a JSON map.

---

## 6. Scheduler architecture

```
server.js
  └── reminderScheduler.start()    ← called after DB authenticate
       └── setInterval(reminderScheduler.tick, SCHEDULER_INTERVAL_MS)
            └── tick()
                 ├── SELECT pending reminders WHERE reminder_at <= NOW() LIMIT 50 FOR UPDATE SKIP LOCKED
                 ├── For each: send via notificationService
                 └── Update status
```

**Why `setInterval` and not a separate worker process:**
- The existing deployment runs one backend process via pm2 (`ecosystem.config.js`).
- Adding a separate worker process doubles the infrastructure surface for v1.
- `FOR UPDATE SKIP LOCKED` handles the edge case of multiple instances safely.
- If the project later moves to multiple backend instances, the scheduler can be extracted into a
  dedicated worker without changing any business logic — `reminderScheduler` is a standalone module.

**Why 5-minute intervals:**
- Follow-up reminders are not time-critical to the minute. A 5-minute delay between the trigger
  time and actual delivery is acceptable for a "3 days before" reminder.
- Shorter intervals (e.g. 1 minute) increase DB load for no practical benefit.

---

## 7. Serializers

```js
function serializeReminder(r) {
  if (!r) return null;
  return {
    id: String(r.id),
    bookingId: String(r.bookingId),
    followUpOn: r.followUpOn,
    reminderAt: r.reminderAt,
    channel: r.channel,
    status: r.status,
    emailStatus: r.emailStatus,
    whatsappStatus: r.whatsappStatus,
    sentAt: r.sentAt,
  };
}

function serializeUpcomingFollowUp(r) {
  return {
    id: String(r.id),
    bookingId: String(r.bookingId),
    doctorName: r.booking?.doctor?.user?.name ?? "",
    clinicName: r.booking?.clinic?.name ?? null,
    followUpOn: r.followUpOn,
    status: r.status,
    reminder: r.status !== "cancelled" ? serializeReminder(r) : null,
  };
}
```

---

## 8. Environment variables

🟡 Add to `config/env.js` (all with safe defaults for dev):

```js
// ── WhatsApp Business (Twilio) ──────────────────────────
WHATSAPP_PROVIDER: Joi.string().valid("twilio", "mock").default("mock"),
TWILIO_ACCOUNT_SID: Joi.string().allow("").default(""),
TWILIO_AUTH_TOKEN: Joi.string().allow("").default(""),
TWILIO_WHATSAPP_FROM: Joi.string().allow("").default(""),  // e.g. "whatsapp:+14155238886"
TWILIO_CONTENT_TEMPLATE_SID: Joi.string().allow("").default(""),

// ── Reminder scheduler ──────────────────────────────────
REMINDER_SCHEDULER_ENABLED: Joi.boolean().default(true),
REMINDER_SCHEDULER_INTERVAL_MS: Joi.number().default(300000),  // 5 minutes
```

---

## 9. Files created

| File | Purpose |
|---|---|
| `backend/src/models/followUpReminder.model.js` | Sequelize model |
| `backend/src/services/followUpReminder.service.js` | Reminder CRUD + patient upcoming list |
| `backend/src/services/reminderScheduler.service.js` | In-process cron scheduler |
| `backend/src/services/notificationService.js` | Channel abstraction (email + WhatsApp) |
| `backend/src/services/whatsapp.service.js` | Twilio WhatsApp Business integration |
| `backend/src/controllers/followUpReminder.controller.js` | Thin controller |
| `backend/src/validators/followUpReminder.validator.js` | Joi schemas |
| `backend/src/db/migrations/029_follow_up_reminders.sql` | Table + column migration |
| `backend/src/templates/emails/follow-up-reminder.html` | Email template |
| `docs-shared/feature-plans/follow-up-reminders-07-09-2026/` | This documentation |

## 10. Files modified

| File | Change |
|---|---|
| `backend/src/models/index.js` | Register FollowUpReminder model + associations |
| `backend/src/models/patientProfile.model.js` | Add `whatsappOptIn` field |
| `backend/src/services/mail.service.js` | Add `sendFollowUpReminder` function |
| `backend/src/server.js` | Start/stop the reminder scheduler |
| `backend/src/config/constants.js` | Add REMINDER_STATUS, REMINDER_CHANNEL, etc. |
| `backend/src/config/env.js` | Add WhatsApp + scheduler env vars |
| `backend/src/routes/doctor.routes.js` | Mount reminder endpoints |
| `backend/src/routes/patient.routes.js` | Mount patient follow-up + opt-in endpoints |
| `backend/src/utils/serializers.js` | Add serializeReminder, serializeUpcomingFollowUp |
| `backend/src/config/swagger.js` | Document new endpoints |
