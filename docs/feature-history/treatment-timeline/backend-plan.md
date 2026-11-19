# Treatment Timeline — Backend Plan

**Read `README.md` first.** Legend: 🟢 exists · 🟡 extend · 🔵 new.

**No migration. No model. No new table.** Every column already exists on `bookings`, `clinics`, `users`/`doctor_profiles`, `clinical_notes` and `prescriptions`. This is a read feature.

---

## 1. Layering

Standard flow, no exceptions:

```
route → validateQuery(schema) → authenticate → authorize → [resolve patient] → controller → service → models
```

Controllers stay thin (read validated input → call one service fn → serialize → `ok()`). All DB access is in `treatmentTimeline.service.js`.

---

## 2. `services/treatmentTimeline.service.js` 🔵

### 2.1 The booking spine

One query. `bookings` is the row spine; doctor/clinic ride along as `include` (both are `belongsTo`, so no cartesian risk and no `separate` needed).

```js
const spineInclude = [
  {
    model: DoctorProfile, as: "doctor", attributes: ["userId"],
    include: [
      { model: User, as: "user", attributes: ["id", "name"] },
      { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name"] },
    ],
  },
  { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
];
```

`where`:
- `patientId` — always. **This is the ownership gate, not a post-filter.**
- `status: { [Op.in]: TIMELINE_STATUSES }` — `['completed']` per README §7-D (pending confirmation).
- year/month — see §2.3.

`order`: `[["slotDate", dir], ["slotStartTime", dir], ["id", dir]]`. The `id` tiebreak is load-bearing: two bookings on the same date+time would otherwise come back in engine order and shuffle between requests.

`limit: TIMELINE_ROW_CAP` (200, README §7-F).

### 2.2 The shared batcher — extract, don't duplicate 🟡

`careJourney.service.js` already does *"given booking ids, attach each one's notes and finalized prescription"* inline. Lift it into one exported helper that **both** services call:

```js
/**
 * Attach each booking's latest clinical note and finalized prescription.
 * ONE query per relation for the WHOLE set (`WHERE booking_id IN (...)`) —
 * never a query per booking. Returns Maps keyed by String(bookingId).
 */
async function attachConsultationArtifacts(bookingIds) { /* → { notesByBooking, rxByBooking } */ }
```

Prescriptions filter `status = 'finalized'` **and** `supersededById: null`, so an amended Rx surfaces the current version, never both.

Migrating `careJourney.service` to this helper must be behaviour-preserving — the journey view's output should be byte-identical after the refactor.

### 2.3 Year / month filtering

Filter in SQL, not in JS (README §7-C):

```js
if (filters.year)  where.slotDate = { [Op.and]: [ where.slotDate, sequelize.where(fn("YEAR",  col("slot_date")), filters.year) ] };
if (filters.month) /* likewise MONTH(slot_date) */
```

`month` without `year` is allowed and means "every March, any year" — that is a legitimate query, so do not reject it.

**The year dropdown needs its own cheap query** — deriving it from the capped row set would hide years beyond the cap:

```js
const listYears = (patientId) => Booking.findAll({
  where: { patientId, status: { [Op.in]: TIMELINE_STATUSES } },
  attributes: [[fn("DISTINCT", fn("YEAR", col("slot_date"))), "year"]],
  order: [[literal("year"), "DESC"]], raw: true,
});
```

### 2.4 Public surface

```js
module.exports = {
  listForPatient,          // (patientId, filters)            → { rows, years, total, capped }
  listByBooking,           // (doctorId, bookingId, filters)  → same · §5.3 in-appointment path
  listByPatient,           // (doctorId, patientId, filters)  → same · §5.4 roster path
  listDoctorPatients,      // (doctorId)                      → the My Patients roster
  attachConsultationArtifacts,   // shared with careJourney.service
};
```

`listByBooking` and `listByPatient` differ **only in their gate**; both end in the same assembler. Write the assembler once and give it a `patientId`.

### 2.5 The two doctor gates (README §7-A0)

**Booking-keyed — `listByBooking`, the in-appointment / in-call path (§5.3).** The narrower gate, and the one the video call uses. Resolve the patient *from the booking the doctor owns*, so the caller can never name a patient at all:

```js
const booking = await Booking.findOne({
  where: { id: bookingId, doctorId },        // ownership IS the lookup
  attributes: ["id", "patientId"],
});
if (!booking) throw ApiError.notFound("Appointment not found");
return assemble(booking.patientId, filters);
```

This mirrors the existing `GET /doctor/bookings/:id/patient-vitals` convention exactly. Because `patientId` is *derived*, not supplied, there is no way for a doctor to pivot from their own appointment to someone else's patient.

**Patient-keyed — `listByPatient`, the roster path (§5.4).** Here the client does name a patient, so assert the relationship **first** and 404 (not 403) on failure — a 403 would confirm the patient exists:

```js
const treated = await Booking.findOne({
  where: { doctorId, patientId, status: { [Op.in]: TREATED_STATUSES } },
  attributes: ["id"],
});
if (!treated) throw ApiError.notFound("Patient not found");
```

In **both** cases the assembler then runs scoped to `patientId` and **not** to this doctor — the whole point is surfacing care given by *other* doctors.

Whether the returned rows carry a usable prescription id depends on README §7-A. If **(b) metadata-only** is chosen, the doctor serializer emits `{ rxNumber, date, canView: false }` and **omits the id**, so there is nothing for a client to call the PDF endpoint with.

### 2.6 The roster — `listDoctorPatients(doctorId)` (§5.4)

The doctor app has no patients concept today; this is it. **One grouped query**, not a fetch-then-loop:

```js
Booking.findAll({
  where: { doctorId, status: { [Op.in]: TREATED_STATUSES } },
  attributes: [
    "patientId",
    [fn("COUNT", col("bookings.id")), "consultationCount"],
    [fn("MAX", col("slot_date")), "lastSeenOn"],
  ],
  include: [{ model: User, as: "patient", attributes: ["id", "name", "profilePhotoUrl"] }],
  group: ["patientId", "patient.id"],
  order: [[literal("lastSeenOn"), "DESC"]],
});
```

→ `[{ patient: { id, name, photoUrl }, consultationCount, lastSeenOn }]`, most-recently-seen first.

Two things to get right:

- **`GROUP BY` must include every non-aggregated selected column** (`patient.id` as well as `patientId`), or MySQL rejects it under `ONLY_FULL_GROUP_BY` — which is on by default in MySQL 8. This will pass in a permissive dev config and fail in production; verify against the real `sql_mode`.
- **The roster is derived from bookings, never from a patients table.** A doctor must never be able to enumerate platform patients they have not treated.

Cap it (`ROSTER_LIMIT`, 500) with the same `capped` flag as the timeline, and note that search/paging over the roster is a follow-up, not v1.

---

## 3. `utils/serializers.js` 🟡 — `serializeTimelineRow(booking, { note, rx }, { viewer })`

```js
{
  bookingId: "128",
  date: "2026-07-02",              // DATEONLY, already "YYYY-MM-DD"
  startTime: "10:30",
  mode: "clinic" | "video",
  location: { name: "City Clinic", city: "Bhubaneswar" } | null,   // null ⇒ video
  doctor: { id: "13", name: "Dr. Asha Rao", specialization: "Orthopedics" | null },
  issue: "L4–L5 disc bulge with radiculopathy" | null,
  prescription: { id: "44", rxNumber: "OSC-2026-000123", canView: true } | null,
}
```

`issue` applies the README §4 fallback chain **here**, in one place, so the timeline and any future consumer agree.

`location: null` + `mode: "video"` is deliberate — the frontend renders the "Video consultation" label so the wording lives with the UI, not the API.

---

## 4. Validator 🔵 `validators/timeline.validator.js`

```js
const listTimeline = Joi.object({
  year:  Joi.number().integer().min(2000).max(2100),
  month: Joi.number().integer().min(1).max(12),
  sort:  Joi.string().valid("newest", "oldest").default("newest"),
});
```

Run through `validateQuery` (Express 5 makes `req.query` read-only, so the reassigning `validate` middleware cannot be used on query strings — `doctorsPublic.routes.js` sets this precedent).

---

## 5. Controllers 🔵 + routes 🟡

```js
// controllers/patientTimeline.controller.js
exports.list = asyncHandler(async (req, res) => {
  const result = await timelineService.listForPatient(req.user.id, req.query);
  return ok(res, result, "Treatment timeline");
});
```

```js
// routes/patient.routes.js  🟡
router.get("/timeline", ...guard, validateQuery(schema.listTimeline), timeline.list);

// routes/doctorBooking.routes.js  🟡
// §5.3 — in-appointment / in-call. Booking-gated; the patient is DERIVED.
// Sits beside the existing `/bookings/:id/patient-vitals`, same convention.
router.get("/bookings/:id/patient-timeline", ...guard, validateQuery(schema.listTimeline), doctorTimeline.listByBooking);

// §5.4 — the My Patients roster and a named patient's timeline.
router.get("/patients", ...guard, doctorTimeline.listPatients);
router.get("/patients/:patientId/timeline", ...guard, validateQuery(schema.listTimeline), doctorTimeline.listByPatient);
```

**Route-order note:** `/patients` is a literal segment and `/patients/:patientId/timeline` is two segments deeper, so they cannot shadow each other. No ordering hazard here — unlike `doctorsPublic.routes.js`, where `/doctors/map` had to precede `/doctors/:slug`.

---

## 6. Swagger 🟡

All four paths under a new **"Treatment Timeline"** tag, plus `TimelineRow` and `DoctorPatient` schemas. Document explicitly that:

- `prescription.canView` reflects the §7-A policy;
- a doctor's rows include **other** doctors' consultations (that is the feature, not a leak);
- `/bookings/:id/patient-timeline` derives the patient and takes no patient parameter;
- `/patients` returns only patients the caller has treated.

---

## 7. Performance

Fixed query count regardless of row count: **1** (spine) **+ 1** (notes) **+ 1** (prescriptions) **+ 1** (distinct years) = **4**, plus **1** for the doctor gate. The roster is **1** grouped query. No `await` inside any loop anywhere.

Indexes: `bookings` is queried by `patient_id` + `slot_date` (timeline) and by `doctor_id` + `status` (roster); `clinical_notes` / `prescriptions` by `booking_id`. Confirm `bookings(patient_id, slot_date)` and `bookings(doctor_id, status)` exist before shipping; add whichever is missing in the timeline's own migration.
