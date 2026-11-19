# Background Jobs and Realtime

There is no queue, no Redis and no separate worker. All recurring work is **in-process timers** started by `server.js` after the HTTP server is listening, plus lazy "sweep on read" updates inside services. State lives in MySQL, so nothing is lost across restarts or deploys.

## 1. Inventory

| Job | File | Trigger / interval | What it does | Multi-instance safety |
|---|---|---|---|---|
| Follow-up reminder scheduler | `services/reminderScheduler.service.js` | `setInterval` every `SCHEDULER_INTERVAL_MS` = 5 min; one tick immediately at start | Claims up to 50 `pending` rows with `reminder_at <= now` (`FOR UPDATE SKIP LOCKED`, marks `processing`), then dispatches outside the lock via `notificationService.send` (e-mail and/or WhatsApp) and writes `sent` / `failed` / back to `pending` with `retry_count` | yes (`SKIP LOCKED`) |
| Medicine reminder sweep | `services/medicineReminder.service.js` | every `MEDICINE_REMINDER_INTERVAL_MS` = 60 s; a slow tick never overlaps the next | (1) due-dose in-app notifications (one per dose; stale doses older than 30 min are not sent; privacy mode hides the medicine name; honours `reminder_enabled` and `web_reminders`), (2) doses still open after 120 min -> `missed`, (3) active routines past their end date (in their own time zone) -> `completed` + notification, (4) hourly top-up of the rolling 7-day dose window | yes (`SKIP LOCKED`) |
| Hold expiry | `availability.expireStaleHolds(sessionId)` | on read, inside `booking.create` | one UPDATE: `pending_payment` bookings older than 10 min -> `cancelled` (`hold_expired`) | n/a |
| Session auto-close | `session.autoCloseStale()` | on read (doctor session lists / queue) | sessions not ended 6 h after `end_time` -> completed | n/a |
| Blood unit expiry | `bloodInventory.expireDue()` | before every inventory read/reserve/issue and on dashboard calls | in-stock units past expiry -> `expired` (reservations released); the dashboard also emits a once-a-day expiring-stock notification | n/a |
| PDF preflight | `prescriptionPdf.preflight()` | once at boot, not awaited | proves Chromium launches; logs a loud error otherwise; warms the browser singleton | n/a |

Both schedulers start only when `REMINDER_SCHEDULER_ENABLED !== false` (default true). They are stopped by `SIGTERM` / `SIGINT`.

### Reminder scheduler details
* `reminder_at` = follow-up date at 09:00 IST minus the chosen interval (IST is a fixed +05:30). Default lead `DEFAULT_REMINDER_DAYS_BEFORE = 3`, `MAX_REMINDER_RETRIES = 3`.
* Channel statuses are tracked separately (`email_status`, `whatsapp_status`). If at least one channel succeeds the reminder is marked `sent` (a partial failure is kept in `last_error`). If none succeed it returns to `pending` until the retry cap, then `failed`.
* In `mock` mode (the default `WHATSAPP_PROVIDER`) WhatsApp counts as sent without sending anything.
* Edge to be aware of (read from code): for a WhatsApp-only reminder the e-mail result is null, so `email_status` is written as `failed` while the reminder still ends `sent` if WhatsApp succeeded. Cosmetic; **Unclear** whether clients display `email_status`.
* The e-mail path needs the patient's e-mail on file and working SMTP (production without SMTP sends nothing and returns null).

### Medicine sweep details
Constants: `DOSE_NOTIFY_STALE_MINUTES = 30`, `DOSE_MISSED_AFTER_MINUTES = 120`, `DOSE_WINDOW_DAYS = 7`, `MAX_REMINDER_TIMES = 6`, snooze choices 5/10/15/30 minutes. The sweep only reaches a website tab or open app via Socket.IO; closed mobile apps rely on local notifications that the patient app schedules from the same dose rows (the legacy `medicine-management-31-10-2026/mobile-notifications.md` describes the client side).

## 2. Socket.IO (`realtime/socket.js`)

| Aspect | Detail |
|---|---|
| Server | `socket.io` 4 attached to the same HTTP server and port; `path: "/socket.io"`, `serveClient: false`, `maxHttpBufferSize: 1024` (clients never send data), `pingInterval 25 s`, `pingTimeout 20 s` |
| CORS | the `CLIENT_URL` origins with credentials (native apps send no Origin) |
| Handshake auth | `socket.handshake.auth.token` must be a valid access JWT (never the query string, which ends up in logs); verified with the same `verifyAccessToken` as HTTP. Missing -> error data `UNAUTHENTICATED`; invalid -> `TOKEN_INVALID` |
| Rooms | each socket joins exactly one room `user:<id>` derived from the verified token; there is no client-to-server join/leave event, so a client cannot listen to another user |
| Expiry | the socket is disconnected when its access token expires (timer capped at 2^31-1 ms); the client refreshes and reconnects |
| Server -> client events | `ready` (authenticated + subscribed; fetch anything missed), `notification` (one serialised `medicine_notifications` row), `medicine_dose_updated` (one serialised dose after a patient action), `medicine_routines_changed` (`{ at }`) |
| Delivery model | the DB row is the source of truth; a Sequelize hook on `MedicineNotification` (`afterCreate`, `afterBulkCreate`) pushes after the transaction commits (`transaction.afterCommit`). Offline clients simply read REST (`GET /api/medicine/notifications`) on reconnect |
| Limits | in-app only: Socket.IO cannot wake a closed app; no OS push service (FCM/APNs) exists in the backend |

Event producers (all write through `MedicineNotification`, so every module is covered by the one hook): booking events, prescription ready, payment reported/confirmed, record-access events (`appointmentNotification.service`); medicine routines and doses (`patientMedicine`, `medicineReminder`); pharmacy orders and low stock; diagnostic requests; blood requests/expiry (`bloodAudit.notify`); ambulance bookings (`ambulanceNotification.notify`). Notification types are enumerated in `NOTIFICATION_TYPES`; `reference_type` tells the app what to open (`booking`, `prescription`, `doctor_access_request`, `patient_medicine`, `medicine_dose`, `diagnostic_request`, `ambulance_booking`, ...).

`GET/PUT/DELETE /api/medicine/notifications*` serve the same feed to every notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider).

## 3. Shutdown

`SIGTERM` / `SIGINT`: stop both schedulers -> `realtime.close()` -> `server.close()` -> `pdfService.shutdown()` (closes Chromium) -> `process.exit(0)`. Nothing waits for in-flight HTTP requests beyond `server.close()` semantics.

## 4. Gaps

* A single process runs the timers; if pm2 were scaled to several instances the reminder queries are lock-safe but the boot-time seeding and `ensure*` patches were designed for one writer (`ecosystem.config.js` pins `instances: 1`).
* No dead-letter handling beyond `failed` status + `last_error`.
* No metrics, health detail or job dashboard (`/api/health` returns a static `ok`).
