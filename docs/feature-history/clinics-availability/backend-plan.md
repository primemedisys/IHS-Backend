# Backend — Clinics & Availability

**Stack:** Node.js + **Express 5** + **Sequelize 6** + **mysql2**, CommonJS, **Joi** validation. This extends the built doctor-onboarding feature under `backend/src/` — copy its shape exactly. The layered flow is non-negotiable (`.claude/skills/backend-conventions`):

```
route → validate(joiSchema) → authenticate → authorize('doctor') → controller → service → model
```

Read `README.md` first (scope, data model, endpoint catalog, gating). **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

---

## 1. Migration — `src/db/migrations/003_clinics_availability.sql` 🔵

Forward-only, idempotent (`CREATE TABLE IF NOT EXISTS`), applied by `npm run migrate` (tracked in `_migrations`, same runner as `002`). Lift the four tables **verbatim** from `docs/dbstruct.md §8–11` — same column names/types/FKs/indexes so the hand-written schema stays the source of truth. **No `doctor_profiles` change** (`online_fee` already exists).

```sql
USE clinic_platform;

CREATE TABLE IF NOT EXISTS clinics                     ( ... );  -- dbstruct.md §8
CREATE TABLE IF NOT EXISTS clinic_availability         ( ... );  -- §9
CREATE TABLE IF NOT EXISTS doctor_online_availability  ( ... );  -- §10
CREATE TABLE IF NOT EXISTS availability_exceptions     ( ... );  -- §11
```

> Copy the full `CREATE TABLE` bodies from `dbstruct.md` (they carry the right `ON DELETE CASCADE`, the `idx_clinic_geo (lat, lng)` index for later discovery, and the `idx_clinicavail_clinic_day` / `idx_onlineavail_doctor_day` lookup indexes). Do **not** touch `bookings`/`payments` here — those belong to the bookings plan.

Verify after running: `SHOW TABLES;` shows the 4 new tables; `npm run migrate` twice is a no-op the second time.

---

## 2. Models 🔵 (+ 🟡 `models/index.js`)

One model file per table, camelCase field → snake_case column (match `underscored: true` usage in the existing `doctorAward.model.js` etc.). Register through `models/index.js`.

| File | Table | Key fields |
|---|---|---|
| `clinic.model.js` 🔵 | `clinics` | `id, doctorId, name, addressLine, city, state, pincode, lat, lng, phone, offlineFee, isActive` |
| `clinicAvailability.model.js` 🔵 | `clinic_availability` | `id, clinicId, dayOfWeek, startTime, endTime, slotDurationMinutes, isActive` |
| `doctorOnlineAvailability.model.js` 🔵 | `doctor_online_availability` | `id, doctorId, dayOfWeek, startTime, endTime, slotDurationMinutes, isActive` |
| `availabilityException.model.js` 🔵 | `availability_exceptions` | `id, doctorId, clinicId (nullable), exceptionDate, reason` |

> `lat`/`lng` are `DECIMAL(10,7)` in the DB — map them as `DataTypes.DECIMAL(10,7)` and coerce to `Number` in the serializer (Sequelize returns DECIMAL as a string). `startTime`/`endTime` are `TIME` — store/return as `"HH:mm"` strings; the serializer trims the `:ss`.

**🟡 `models/index.js` — associations** (doctor FKs point at `doctor_profiles.user_id` = `DoctorProfile`'s PK `userId`):

```js
// Doctor → many clinics
DoctorProfile.hasMany(Clinic, { foreignKey: "doctorId", as: "clinics", onDelete: "CASCADE" });
Clinic.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Clinic → many weekly slots
Clinic.hasMany(ClinicAvailability, { foreignKey: "clinicId", as: "availability", onDelete: "CASCADE" });
ClinicAvailability.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// Doctor → many online slots (independent of any clinic)
DoctorProfile.hasMany(DoctorOnlineAvailability, { foreignKey: "doctorId", as: "onlineAvailability", onDelete: "CASCADE" });
DoctorOnlineAvailability.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Doctor → many exceptions; optionally scoped to a clinic
DoctorProfile.hasMany(AvailabilityException, { foreignKey: "doctorId", as: "exceptions", onDelete: "CASCADE" });
AvailabilityException.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });
```

Export all four new models from `models/index.js`.

---

## 3. Validators — `validators/clinic.validator.js` 🔵 (Joi)

One schema per writable endpoint; wired in the route via `validate(schema.x)`. Import the day/time helpers, don't retype literals.

```js
const Joi = require("joi");

const HHMM = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).message('time must be "HH:mm"');

const createClinic = Joi.object({
  name:       Joi.string().trim().max(150).required(),
  addressLine:Joi.string().trim().max(255).required(),
  city:       Joi.string().trim().max(100).allow("", null),
  state:      Joi.string().trim().max(100).allow("", null),
  pincode:    Joi.string().trim().max(20).allow("", null),
  lat:        Joi.number().min(-90).max(90).required(),
  lng:        Joi.number().min(-180).max(180).required(),
  phone:      Joi.string().trim().max(20).allow("", null),
  offlineFee: Joi.number().min(0).required(),
});
const updateClinic = createClinic.fork(Object.keys(createClinic.describe().keys), (s) => s.optional())
  .append({ isActive: Joi.boolean() }).min(1);

// A weekly slot; endTime must be after startTime and the window must fit at least one slot.
const weeklySlot = Joi.object({
  dayOfWeek:           Joi.number().integer().min(0).max(6).required(),
  startTime:           HHMM.required(),
  endTime:             HHMM.required(),
  slotDurationMinutes: Joi.number().integer().min(5).max(240).default(15),
}).custom((v, helpers) => (v.endTime > v.startTime ? v : helpers.error("any.invalid")))
  .message("endTime must be after startTime");

const setAvailability = Joi.object({ slots: Joi.array().items(weeklySlot).max(50).required() });
// empty array is allowed → "clear this schedule"; the completeness rule handles "must have ≥1 window somewhere"

const createException = Joi.object({
  clinicId:      Joi.number().integer().positive().allow(null),  // null = online-schedule exception
  exceptionDate: Joi.date().iso().required(),
  reason:        Joi.string().trim().max(255).allow("", null),
});
```

> `:id` path params are validated in the controller/service by ownership lookup (findByPk → check `doctorId === req.user.id`), not by Joi. Overlap **between** slots in one submission is allowed (§README 6) — do **not** reject overlaps here.

Add a `SLOT_DEFAULT_MINUTES` and `MAX_SLOTS_PER_SCHEDULE` to `config/constants.js` 🟡 and reference them in both the model default and this schema (no literal drift).

---

## 4. Services 🔵

All business logic + DB access. Multi-row writes go in `sequelize.transaction`. **No queries in loops** — use `include`, `Op.in`, `bulkCreate`, set-replace.

### 4.1 `services/clinic.service.js` 🔵

```js
listClinics(userId)                 // Clinic.findAll where doctorId=userId, include: availability. ONE query.
getClinic(userId, clinicId)         // findOne where {id, doctorId:userId} include availability; else 404.
addClinic(userId, body)             // Clinic.create({ ...body, doctorId: userId }).
updateClinic(userId, clinicId, patch)  // ownership-checked update.
removeClinic(userId, clinicId)      // ownership-checked destroy (cascades availability + exceptions.clinicId).
```

**Ownership is a WHERE clause, never a post-load `if`.** Every `:id` op filters `{ id, doctorId: userId }` so another doctor's clinic simply 404s (no info leak) — same pattern the onboarding awards/links CRUD uses.

### 4.2 `services/availability.service.js` 🔵

```js
// Per-clinic weekly schedule — REPLACE the set atomically (like setSpecializations).
getClinicAvailability(userId, clinicId)          // assert clinic ownership, then its slots.
setClinicAvailability(userId, clinicId, slots) {
  // 1. assert clinic belongs to userId (else 404)
  // 2. tx: ClinicAvailability.destroy({ where:{ clinicId } });
  //        ClinicAvailability.bulkCreate(slots.map(s => ({ ...s, clinicId })));
}

// Online (video) weekly schedule — same replace-the-set, keyed by doctor.
getOnlineAvailability(userId)                     // DoctorOnlineAvailability.findAll where doctorId=userId.
setOnlineAvailability(userId, slots)              // tx: destroy where doctorId + bulkCreate.

// Exceptions
listExceptions(userId)
addException(userId, { clinicId, exceptionDate, reason })  // if clinicId given, assert it's the doctor's.
removeException(userId, id)                        // ownership-checked destroy.

// Read-only slot preview (public) — pure expansion, NO bookings subtracted (README §6).
previewSlots({ doctorId, mode, clinicId, date }) {
  // 1. dow = new Date(date).getUTCDay()
  // 2. pick the weekly rows for that dow (clinic_availability for mode=clinic+clinicId, else online)
  // 3. if an availability_exception matches (date, and clinic scope) → return []
  // 4. expand each window into [start, start+dur, ...) < end; return ["HH:mm", ...]
  //    (bookings module will later subtract taken times — keep the return shape a flat time list)
}
```

`setClinicAvailability`/`setOnlineAvailability` are the **only** writers for slots — no per-row create/delete endpoints, so the schedule can never end up half-saved.

### 4.3 Completeness — 🟡 `services/verification.service.js`

The single edit that turns these into onboarding steps (README §4). `computeChecklist(profile)` currently returns `clinics: null, availability: null`. With `clinics` + `onlineAvailability` now in `fullInclude` (§7):

```js
const activeClinics = (profile.clinics || []).filter((c) => c.isActive);
const hasClinicSlot  = activeClinics.some((c) => (c.availability || []).some((a) => a.isActive));
const hasOnlineSlot  = (profile.onlineAvailability || []).some((a) => a.isActive);
return {
  // ...professional, specialties, portfolio, documents (unchanged)...
  clinics:      activeClinics.length >= 1,
  availability: hasClinicSlot || hasOnlineSlot,   // README §4: ≥1 window anywhere
  bank:         null,                              // still deferred (payments plan)
};
```

And in `config/constants.js` 🟡, append to the existing frozen array:

```js
const ONBOARDING_REQUIRED_STEPS = Object.freeze([
  "professional", "specialties", "portfolio", "documents",
  "clinics", "availability",     // ⟵ this plan
]);
```

Nothing else in `verification.service` changes — `getOnboarding`, `submit`, and `canSubmit` already read the list generically, so the submit guard now enforces clinics + availability for free.

---

## 5. Controllers & routes 🔵

**Controllers stay thin** (`controllers/clinic.controller.js`): read validated input + `req.user.id` + `req.params.id`, call exactly one service fn, serialize, respond via `ok()/created()`. Wrap in `asyncHandler`. No `Model.` calls.

**`routes/clinic.routes.js`** 🔵 — every route `authenticate` + `authorize(ROLES.DOCTOR)`; mounted under `/doctor`:

```js
const guard = [authenticate, authorize(ROLES.DOCTOR)];
router.route("/clinics").all(...guard)
  .get(clinic.list).post(validate(schema.createClinic), clinic.create);
router.route("/clinics/:id").all(...guard)
  .get(clinic.getOne).patch(validate(schema.updateClinic), clinic.update).delete(clinic.remove);
router.route("/clinics/:id/availability").all(...guard)
  .get(availability.getClinic).put(validate(schema.setAvailability), availability.setClinic);
router.route("/online-availability").all(...guard)
  .get(availability.getOnline).put(validate(schema.setAvailability), availability.setOnline);
router.route("/exceptions").all(...guard)
  .get(availability.listExceptions).post(validate(schema.createException), availability.addException);
router.delete("/exceptions/:id", ...guard, availability.removeException);
```

**Public slot preview** goes in the existing `routes/doctorsPublic.routes.js` 🟡 (no auth):
```js
router.get("/doctors/:id/slots", validate(schema.slotQuery, "query"), publicDoctor.slots);
```
> The public `/doctors/:slug` route is **unchanged** — it already returns `clinics`/`onlineAvailability`; only the serializer (§7) now fills them.

**🟡 `routes/index.js`** — one new mount line: `router.use("/doctor", require("./clinic.routes"));` (the existing `/doctor` doctor.routes mount stays; Express merges both routers under the prefix — or fold these routes into `doctor.routes.js` if the team prefers one file per prefix).

---

## 6. Serializers — `utils/serializers.js` 🟡

Add clinic/availability mappers and **fill the two empty blocks** in `serializePublicDoctor` (currently `clinics: []`, `onlineAvailability: null`). Map onto the **existing** frontend `Clinic` / `OnlineAvailability` types (`frontend-doctor/src/types/doctor.ts`) so the public page needs zero type changes:

```js
serializeClinic(c)          // -> { id, name, address(addressLine), city, stateCode(state), lat:Number,
                            //      lng:Number, phone, fee:Number(offlineFee), days:["Mon",...], // from availability dows
                            //      openTime, closeTime, slotMinutes }   ← matches type Clinic
serializeOnlineAvailability(rows) // -> { days, openTime, closeTime, slotMinutes } | null

// in serializePublicDoctor(profile):
clinics: (profile.clinics || []).filter(c => c.isActive).map(serializeClinic),
onlineAvailability: serializeOnlineAvailability(profile.onlineAvailability),
// and set onlineConsult = onlineAvailability != null; hospital/lat/lng from the primary clinic.
```

> The public `Clinic` type flattens a clinic's weekly slots into `days[] + openTime/closeTime/slotMinutes` (the mock did the same). When a clinic has heterogeneous windows, use the earliest open / latest close for the card summary and expose the exact per-day grid only via `/doctors/:id/slots`. The **owner** serializer (`serializeOwnClinic`) returns the full `availability[]` untouched for the editor.

Extend `doctor.service.fullInclude` 🟡 to eager-load the two relations so the public read, the onboarding checklist, and the owner profile all get them in one query:
```js
{ model: Clinic, as: "clinics", include: [{ model: ClinicAvailability, as: "availability" }] },
{ model: DoctorOnlineAvailability, as: "onlineAvailability" },
```

---

## 7. Config, swagger, deps

- **`config/constants.js`** 🟡: `SLOT_DEFAULT_MINUTES`, `MAX_SLOTS_PER_SCHEDULE`, the `ONBOARDING_REQUIRED_STEPS` append (§4.3), and a `DAYS` array (`["Sun".."Sat"]`) shared by the serializer.
- **`config/env.js`** 🟡: **nothing required** — the backend does no Google calls this plan (Maps is browser-side, README §5). (S3/upload env from the previous plan is untouched.)
- **`config/swagger.js`** 🟡: OpenAPI entries for every new route under a `Clinics & Availability` tag; document `WeeklySlot` and the `slots` replace-the-set body explicitly.
- **Dependencies:** none new. (No new npm packages — pure Sequelize + Joi.)

---

## 8. Build order (backend)

1. 🔵 `003_clinics_availability.sql` → `npm run migrate`; 🔵 four models + associations in `index.js`.
2. 🟡 extend `fullInclude` + `serializePublicDoctor` (fill clinics/online) + `serializeClinic`/`serializeOwnClinic` → smoke-test `/doctors/:slug` on a seeded doctor with clinics.
3. 🔵 `clinic.validator.js`; 🔵 `clinic.service.js` + controller + `clinic.routes.js` (CRUD, ownership).
4. 🔵 `availability.service.js` (per-clinic + online replace-the-set) + exceptions endpoints.
5. 🔵 `previewSlots` + public `/doctors/:id/slots`.
6. 🟡 `verification.service.computeChecklist` (fill clinics/availability) + 🟡 `ONBOARDING_REQUIRED_STEPS` append → verify onboarding/submit react.
7. 🟡 swagger entries as each route lands.

---

## 9. Testing checklist (backend)

- [ ] Migration idempotent (run twice, no error); 4 tables present with the geo + day indexes.
- [ ] `POST /doctor/clinics` creates a clinic owned by the caller; another doctor's token can't `GET/PATCH/DELETE` it (→ 404, no leak).
- [ ] `PUT /doctor/clinics/:id/availability` with `endTime <= startTime` → 422; a valid set **replaces** (old rows gone, no dupes) inside one transaction; empty `slots` clears the schedule.
- [ ] `PUT /doctor/online-availability` behaves identically, keyed by doctor.
- [ ] Deleting a clinic cascades its `clinic_availability` and clinic-scoped `availability_exceptions`.
- [ ] `POST /doctor/exceptions` with a `clinicId` the doctor doesn't own → 404; with `clinicId:null` records an online exception.
- [ ] `GET /doctor/onboarding`: `clinics` flips true only with ≥1 **active** clinic; `availability` flips true with ≥1 clinic slot **or** ≥1 online slot; both `false` → `canSubmit=false`.
- [ ] `POST /doctor/submit` with no clinic → `422 ONBOARDING_INCOMPLETE` (`details.steps.clinics=false`); complete → `is_submitted=1`.
- [ ] `GET /doctors/:slug` (approved) now returns non-empty `clinics[]` with map pins + a non-null `onlineAvailability`; a doctor with no online slots → `onlineAvailability:null`, `onlineConsult:false`.
- [ ] `GET /doctors/:id/slots?mode=clinic&clinicId&date`: expands the weekly window minus exceptions; an exception date → `[]`; does **not** subtract bookings (documented).
- [ ] Every `/doctor/*` route 403s for a patient/admin token; the slots + slug reads need no token; no response leaks another doctor's clinics.
