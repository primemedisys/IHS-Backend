# Bug fixes 18/07/2026 — Backend

**Read `README.md` first.** Legend: 🟢 exists · 🟡 extend · 🔵 new.

---

## 1. Session & rate limiting

### 1.1 `services/token.service.js` 🟡 — rotation grace window

```js
const REFRESH_REUSE_GRACE_MS = 30_000;

if (row.revokedAt) {
  const sinceRotation = Date.now() - new Date(row.revokedAt).getTime();
  if (sinceRotation > REFRESH_REUSE_GRACE_MS) {
    await revokeAllForUser(row.userId);   // genuine theft
    throw ApiError.unauthorized("Refresh token reuse detected", …);
  }
  // inside the window → the losing side of a concurrent refresh; fall through
}
```

The subsequent revoke is guarded with `if (!row.revokedAt)` so a grace-window replay does not push the rotation timestamp forward — without that, a token could be replayed indefinitely, 30s at a time, and the theft detection would never fire.

### 1.2 `middlewares/rateLimiters.js` 🟡 + `routes/auth.routes.js` 🟡

`refreshLimiter` (its own bucket, no `skipSuccessfulRequests`) is now wired to `/auth/refresh`. It was written but never connected — `/refresh` still used `authLimiter`.

### 1.3 `config/env.js` 🟡

| Key | Default | Why |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` | Read by `app.js` for `trust proxy`. Every per-IP limiter keys off `req.ip`; too low and all users share one bucket. |
| `REFRESH_RATE_LIMIT_MAX` | `120` | **Was missing entirely** → `undefined` → the library's default of 5. |
| `RATE_LIMIT_MAX` | `100` → `600` | A DoS backstop, not a usage quota. ~7/min is far too tight for a dashboard, and a clinic behind one NAT shares it. |

`app.js` 🟡 now reads `app.set("trust proxy", env.TRUST_PROXY_HOPS)`.

---

## 2. Treatment timeline

### 2.1 `services/treatmentTimeline.service.js` 🔵

```js
module.exports = {
  attachConsultationArtifacts,  // shared with careJourney.service
  listForPatient,               // patient's own
  listByBooking,                // §5.3 — booking-keyed, patient DERIVED
  listByPatient,                // §5.4 — patient-keyed, treating-relationship asserted
  listDoctorPatients,           // My Patients roster
};
```

**Query budget is fixed:** 1 spine + 1 notes + 1 prescriptions + 1 distinct-years (+1 for the doctor gate). No `await` inside any loop.

**The two doctor gates** differ only in how the patient is resolved:

- **Booking-keyed** — `where: { id: bookingId, doctorId }`, then `booking.patientId`. Because the patient id is *derived*, the route takes no patient parameter and cannot be pivoted to someone else's patient. Reuses `patientVitals.service.gateBookingPatient` (now exported) so the unlock rule can't diverge from the vitals table.
- **Patient-keyed** — asserts a `TREATED_BOOKING_STATUSES` booking exists, else **404** (not 403 — a 403 would confirm the patient exists).

In both cases the assembler then runs scoped to `patientId` and **not** to this doctor: surfacing other doctors' care is the feature.

**Roster** is one grouped query over the doctor's own bookings (`COUNT` + `MAX(slot_date)`), never a listing of the patients table. `group` includes `patient.id` as well as `patientId` — MySQL 8 runs `ONLY_FULL_GROUP_BY` by default and rejects a non-aggregated selected column that isn't grouped. The dev DB has that mode **off**, so it was re-tested with it forced on.

**Date filters** use `sequelize.where(fn("YEAR", col("slot_date")), value)` — bound, never interpolated. `month` without `year` is allowed ("every March, any year").

**Row ordering** ends in `id` as a tiebreak: without it, two same-date same-time bookings return in engine order and can shuffle between requests.

### 2.2 `services/careJourney.service.js` 🟡 — extraction

Its inline "attach notes + prescriptions" block was lifted into `attachConsultationArtifacts` and both services now call it. The prescription query gained `diagnosis` (needed for the timeline's Issue fallback); the journey serializer picks fields explicitly, so that costs it nothing.

**Verified behaviour-preserving:** five journeys' serialized output captured before the refactor and diffed after → byte-identical.

### 2.3 The Issue column

Resolved in `utils/serializers.timelineIssue`, in this order: clinical-note `diagnosis` → prescription `diagnosis` → note `complaints` → `null`. The prescription fallback matters — a doctor who prescribes without writing a note is common, and getting the order wrong makes most rows read `—` while the data sits right there.

---

## 3. Vitals reference ranges

### 3.1 `config/vitalsRanges.js` 🔵 — the single source of truth

Exports `evaluate(key, value, { age })`, `evaluateEntry`, `normalRangeFor`, `parseBloodPressure`, plus the `VITAL_STATUS` vocabulary and two guideline switches:

```js
const BP_STANDARD  = "who";    // "who" | "acc_aha"
const BMI_STANDARD = "asian";  // "asian" | "international"
```

Bands are ordered, first-match, with **both bounds inclusive** — the clinical thresholds are exact (100.4 °F is fever; 100.3 is not).

**Fields absent from the table evaluate to `unknown`**, so "not colourable" is the default and adding a field is a deliberate act. Weight and Height are deliberately absent.

**SpO₂ is one-sided** — the scale caps at 100, so there is no high band, and the dangerous direction is *down*: 88–90 is `high` severity, <88 is `critical`. Never `low`/blue.

**`parseBloodPressure` fails safe.** The column is free text, so it sees `"130/85"`, `"130 / 85"`, `"130-85"` and junk. Anything it cannot read with confidence → `null` → `unknown`. Physiologically impossible readings are data errors, not hypertension. The status is the **worse of** systolic and diastolic (135/95 is high on diastolic alone).

**Age gate:** `age == null || age < 18` → `unknown`. A missing DOB is not guessed.

### 3.2 `utils/serializers.js` 🟡

`VITALS_MATRIX_FIELDS` gains `normal` (absent for Weight/Height). Each entry gains a `statuses` map **parallel to `values`** — `values` is untouched, so the prescription prefill, the render view and the PDF keep working unchanged. Nesting `{ value, status }` inside `values` would have broken all of them.

### 3.3 `services/patientVitals.service.js` 🟡 + `utils/age.js` 🔵

`listForPatient` now returns `{ rows, age }`, loading the DOB **once per request** alongside the rows. Both read paths (patient's own, doctor's booking-scoped) go through it, so an identical reading bands identically on both sides — the specific failure this feature exists to prevent.

`ageFrom` was private to `prescription.service`; it is now `utils/age.js`, shared. Two copies would eventually disagree at a birthday boundary, and one consumer stamps its answer onto a signed document.

---

## 4. Appointment rescheduling

### 4.1 `services/booking.service.js` 🟡 — `reschedule(doctorId, id, { date, startTime, reason })`

Confirmed bookings only. Validates through the **same** `resolveBookableSlot` a patient booking uses, then writes the new slot and the audit fields. A `UniqueConstraintError` from the generated `active_lock_key` becomes `409 SLOT_TAKEN` — the race is resolved by the database, not a check-then-write.

### 4.2 `services/availability.service.js` 🟡 — two new options

| Option | Why |
|---|---|
| `requireListed = true` | `false` for doctor-owned actions. The public-listing gate is about patient discovery; it must not stop a hidden doctor managing appointments they already have (it 404'd with a confusing "Doctor not found"). |
| `ignoreBookingId = null` | The booking being moved must not count as "taken" against itself. Threaded into `takenStartTimes`. |

### 4.3 Migration `016_booking_reschedule.sql` 🔵 + `ensureBookingRescheduleColumns.js` 🔵

`bookings.rescheduled_at` (DATETIME NULL) + `rescheduled_reason` (VARCHAR(255) NULL). Both NULL for existing rows.

---

## 5. Prescriptions

### 5.1 Migration `015_prescription_duration_unit.sql` 🔵 + shim 🔵

`prescription_items.duration_unit ENUM('day','week','month') NOT NULL DEFAULT 'day'`. The column keeps its `duration_days` name (the number is still the count) and defaults to `day`, so every existing row means exactly what it meant before.

Wired through `models/prescriptionItem.model.js` 🟡, `config/constants.MEDICINE_DURATION_UNITS` 🔵, `validators/prescription.validator.js` 🟡, `utils/serializers.js` 🟡 and `services/prescriptionPdf.service.cell()` 🟡.

### 5.2 `services/prescription.service.getPdfForDoctor` 🟡 — treating-doctor access

Two ways in, in order:

1. **They authored it** — any status, including their own draft.
2. **It is FINALIZED and belongs to a patient they treat** — deliberately narrower: never someone else's half-written draft, and only for a patient this doctor has a booking with.

A doctor with no booking for that patient gets the same 404 as a stranger. Verified.

---

## 6. Uploads

`middlewares/upload.js` 🟡 — `isAllowedMime` matches **`image/*` by prefix** plus an explicit document list (PDF, Word, plain text). Prefix-matching means a format we haven't heard of still works; the list means executables, archives and scripts never do, because these files are served back in-browser.

---

## 7. Verification performed

| Area | Result |
|---|---|
| Token rotation | Two concurrent refreshes both succeed, 3 sessions alive; reuse 10 min later still revokes the family |
| Rate limits | 15 bad logins → 401×10 then 429×5; 30 bad refreshes → 401×30, no 429 |
| Timeline | All 4 endpoints 200 with correct rows; gates 404; filters and sort correct |
| `careJourney` refactor | Byte-identical output across 5 journeys |
| Roster | Passes with `ONLY_FULL_GROUP_BY` forced on |
| Vitals ranges | 38 boundary cases pass on both sides of every threshold |
| Reschedule | Both modes moved successfully; past/unavailable/other-doctor/cross-mode all rejected |
| Doctor PDF gate | Author OK · stranger 404 |
| Module load | `require('./src/app')` clean |
