# Medicine Management — API reference

All endpoints use the existing envelope `{ success, message, data }` and the
existing `Authorization: Bearer <access token>`. Errors: `{ error: { message, code, details } }`.
IDs are strings. Times: `scheduledAt` / `dueAt` / `actionAt` are UTC ISO strings;
`scheduledTime` / `reminderTimes` are the patient's **local wall-clock** `"HH:MM"`
(24-hour) in the routine's `timezone`.

## Patient — `/api/patient/medicines` (role: patient)

Every call is keyed on the signed-in patient. No endpoint accepts a patient id.

| Method | Path | Purpose |
|---|---|---|
| GET | `/patient/medicines?status=&source=` | List routines. `status`: active / paused / completed / cancelled. `source`: prescription / patient |
| POST | `/patient/medicines` | Add 1–10 of the patient's OWN medicines in one transaction (the cart "confirm") |
| GET | `/patient/medicines/search?q=` | Search the shared catalogue (min 2 chars, max 20 hits) |
| GET | `/patient/medicines/summary` | Dashboard numbers (today, next dose, routines, adherence) |
| GET | `/patient/medicines/doses?from=&to=` | Doses whose original slot **or** (snoozed) due time falls in a UTC range (≤ 8 days). No params = patient's local today |
| GET | `/patient/medicines/doses/history?page=&limit=&patientMedicineId=&status=` | Past doses, newest first |
| POST | `/patient/medicines/doses/:doseId/action` | Taken / Skip / Snooze (idempotent) |
| GET | `/patient/medicines/settings` | Reminder preferences |
| PUT | `/patient/medicines/settings` | Update preferences |
| GET | `/patient/medicines/:id` | One routine + `recentDoses` (last 14 days) |
| PATCH | `/patient/medicines/:id` | Edit (prescribed routines: reminder fields only) |
| PUT | `/patient/medicines/:id/status` | `{ status: "paused" \| "active" \| "cancelled" }` — pause / resume / stop |

### Routine object (`PatientMedicine`)

```jsonc
{
  "id": "12",
  "source": "prescription",            // or "patient"
  "verified": true,                    // true only for a doctor's finalized prescription
  "prescriptionId": "88", "prescription": { "id": "88", "rxNumber": "OSC-2026-000123", "finalizedAt": "…" },
  "prescriber": { "id": "5", "name": "Asha Rao" },   // null for patient entries
  "medicineMasterId": "301",
  "medicineName": "Paracetamol", "genericName": "Acetaminophen",
  "strength": "500 mg", "dosageForm": "tablet",
  "dose": "1 tablet", "frequency": "BD", "foodTiming": "after_food",   // before_food | after_food | with_food | anytime | null
  "reminderTimes": ["08:00", "20:00"], "daysOfWeek": null,             // null = every day, else [0..6] (0 = Sunday)
  "timezone": "Asia/Kolkata",
  "startDate": "2026-10-31", "durationDays": 5, "endDate": "2026-11-04", // durationDays null = ongoing
  "instructions": "…",
  "prescribed": { /* doctor's original line, frozen; null for patient entries */
    "medicineName": "Paracetamol 500 mg", "strength": "500 mg", "dosageForm": "tablet", "dosage": "1 tablet",
    "route": "oral", "frequency": "BD", "timing": "after_food", "durationDays": 5, "durationUnit": "day",
    "quantity": null, "notes": null, "rxNumber": "…", "finalizedAt": "…" },
  "reminderEnabled": true,
  "status": "active", "statusReason": null,   // patient | ended | prescription_amended
  "statusChangedAt": null, "supersededById": null,
  "needsSetup": false,                // active but no reminder times → ask the patient to set them
  "suggestedReminderCount": 2,        // from frequency (OD 1, BD 2, TDS 3, QID 4, HS 1, "1-0-1" 2…); null = patient decides
  "createdAt": "…", "updatedAt": "…"
}
```

### POST `/patient/medicines`

```jsonc
{
  "timezone": "Asia/Kolkata",          // optional; IANA zone of the device. Defaults to the patient's setting
  "items": [{
    "clientRequestId": "a1b2c3",       // optional, [A-Za-z0-9_-]{..64}; a retry with the same id returns the same row
    "medicineMasterId": "301",         // EITHER pick from /search (identity comes from the catalogue) …
    "medicineName": "My syrup",        // … OR type it (required, ≥2 chars, when no medicineMasterId)
    "genericName": null, "strength": "5 ml", "dosageForm": "syrup",   // dosageForm ∈ MEDICINE_TYPES (below)
    "dose": "10 ml", "frequency": "TDS", "foodTiming": "after_food",
    "reminderTimes": ["08:00", "14:00", "20:00"],   // 0–6 unique HH:MM
    "daysOfWeek": null,
    "startDate": "2026-10-31",          // required, YYYY-MM-DD
    "durationDays": 7,                  // 1–3650 or null (ongoing)
    "instructions": null,
    "reminderEnabled": true             // default true when reminderTimes is non-empty
  }]
}
```
→ `201`, `data: PatientMedicine[]`. Each item keeps its own schedule.
Patient-entered medicines are private to the patient (never written to the shared catalogue).

### PATCH `/patient/medicines/:id`

Any of: `medicineName, genericName, strength, dosageForm, dose, frequency, foodTiming,
reminderTimes, daysOfWeek, startDate, durationDays, instructions, reminderEnabled, timezone`.

For `source: "prescription"` only `reminderTimes, daysOfWeek, startDate, reminderEnabled, timezone`
are allowed; any prescribed field → `409 PRESCRIBED_FIELD_LOCKED` (`details.fields`).
Completed / cancelled routines → `409 PATIENT_MEDICINE_NOT_EDITABLE`.
Setting reminder times for the first time switches `reminderEnabled` on unless sent `false`.
Schedule changes rebuild future un-actioned doses; past doses are kept.

### Dose object

```jsonc
{
  "id": "991", "patientMedicineId": "12",
  "scheduledDate": "2026-10-31", "scheduledTime": "20:00",
  "scheduledAt": "2026-10-31T14:30:00.000Z",   // the original slot (never moves)
  "dueAt": "2026-10-31T14:40:00.000Z",         // = scheduledAt, or later after a snooze
  "status": "pending",                          // pending | taken | skipped | snoozed | missed
  "snoozeCount": 1, "actionAt": null, "actionSource": null,  // web | mobile | notification | system
  "medicine": { "id": "12", "source": "prescription", "medicineName": "Paracetamol", "strength": "500 mg",
                "dosageForm": "tablet", "dose": "1 tablet", "foodTiming": "after_food", "instructions": null,
                "status": "active", "reminderEnabled": true, "timezone": "Asia/Kolkata" }
}
```

Doses are generated for a rolling window (today → +7 days, local), only for **active**
routines **with reminder times**. A dose open (pending/snoozed) 120 min past `dueAt` becomes `missed`.

### POST `/patient/medicines/doses/:doseId/action`

```jsonc
{ "action": "taken" | "skipped" | "snooze",
  "snoozeMinutes": 5 | 10 | 15 | 30,   // required for snooze only
  "source": "web" | "mobile" | "notification",
  "actedAt": "ISO"                      // optional, for queued offline actions (bounded server-side)
}
```
→ `200 { dose, changed }`. Repeating `taken` on a taken dose (or `skipped` on a skipped one)
returns `changed: false` — no duplicate. Errors: `409 DOSE_ALREADY_TAKEN`, `409 DOSE_NOT_ACTIONABLE`
(> 12 h ahead, snoozing a non-open dose / paused routine, > 12 snoozes), `404`.
Allowed: pending/snoozed/missed/skipped → taken; pending/snoozed/missed → skipped; pending/snoozed → snooze.

### GET `/patient/medicines/summary`

```jsonc
{ "timezone": "Asia/Kolkata",
  "today": { "date": "2026-10-31", "total": 6, "taken": 2, "pending": 3, "snoozed": 0, "skipped": 0, "missed": 1 },
  "nextDose": Dose | null,
  "routines": { "active": 3, "paused": 1, "completed": 4, "cancelled": 0, "prescribed": 2, "own": 2, "needsSetup": 1 },
  "adherence": {
    "week":  { "taken": 10, "skipped": 1, "missed": 2, "due": 13, "percent": 77 },   // percent null when due = 0
    "month": { … },
    "days": [{ "date": "2026-10-25", "taken": 2, "skipped": 0, "missed": 0, "due": 2, "percent": 100, "pending": 0 }, …7]
  } }
```
Adherence = taken ÷ (taken + skipped + missed). Not-yet-due doses never count; delivered reminders never count.

### Settings

```jsonc
{ "privacyMode": false,        // true → reminders say "It's time for your 8:00 PM medicine" (no name/dose)
  "webReminders": true,        // in-app/browser reminders on the website
  "defaultSnoozeMinutes": 10,  // 5 | 10 | 15 | 30
  "timezone": "Asia/Kolkata",  // changing it moves every live routine to the new zone (times stay wall-clock)
  "snoozeOptions": [5, 10, 15, 30] }
```

## Real-time (existing Socket.IO channel, room `user:<id>`)

| Event | Payload | Meaning |
|---|---|---|
| `notification` | notification row | Existing event. New `type`s below |
| `medicine_dose_updated` | Dose | A dose changed on another device — update the UI |
| `medicine_routines_changed` | `{ at }` | Routines were added/edited/paused/synced — refetch lists, **reschedule local alarms** |

New notification types (`medicine_notifications.type`), all to the patient:
`medicine_prescribed`, `medicine_prescription_updated` (referenceType `prescription`),
`medicine_added`, `medicine_routine_completed`, `medicine_routine_paused`, `medicine_routine_stopped`
(referenceType `patient_medicine`, referenceId = routine id or null),
`medicine_dose_due` (referenceType `medicine_dose`, referenceId = dose id).

## Doctor — `/api/doctor/medicines` (existing, extended)

New optional fields on create / PATCH and in every response:
`genericName` (≤255), `manufacturer` (≤255), `description` (≤2000), `medicineMasterId` (catalogue row picked).
When `dosageForm` (or `medicineMasterId`) is given the medicine is linked to the shared catalogue
(`medicine_masters`) — the picked row, or the one with the same NAME|STRENGTH|FORM identity, created
if none exists. No admin approval. Response adds `medicineMasterId`.

`GET /api/doctor/emr/search/medicines?q=` (existing) — `source: "mine"` hits now also carry
`genericName`, `manufacturer`, and `catalogueId` (the linked catalogue row, may be null).

`strength` stays one string ("500 mg"). UIs offer a number + unit picker
(mg, mcg, g, ml, mg/ml, mg/5ml, IU, %, other) and compose/parse that string.

Dosage forms (`MEDICINE_TYPES`): tablet, capsule, syrup, injection, drops, cream, ointment, gel,
spray, inhaler, powder, other.

## Prescription → patient sync

Runs after `POST /doctor/prescriptions/:id/finalize` commits (web and mobile use the same endpoint).
One patient routine per prescription line (`source: "prescription"`), idempotent. Drafts never sync.
Amendments: when the new version is finalized, the previous version's live routines become
`cancelled` / `prescription_amended` and new ones are created (reminder times + start date carried over
when the same medicine + frequency remain). Patient-added medicines are never touched.
New prescribed routines arrive with `reminderTimes: []`, `needsSetup: true` — the patient picks times.
