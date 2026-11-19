# Clinic Account — Backend Plan

**Read `README.md` first.** Legend: 🟢 exists · 🟡 extend · 🔵 new.

Layering is non-negotiable (`.claude/skills/backend-conventions`):
`route → validateQuery/validate(Joi) → authenticate → authorize → resolveClinicPatient → controller (thin) → service (all DB) → model`.

---

## 0. Naming — settle before writing a file

These already exist and mean **a doctor's physical location**:
`models/clinic.model.js` · `services/clinic.service.js` · `controllers/clinic.controller.js` · `routes/clinic.routes.js` (mounted at `routes/index.js:29` as `router.use("/doctor", clinicRoutes)`).

New work uses:
- **`ClinicProfile`** model → table `clinic_profiles` (mirrors `doctor_profiles` / `patient_profiles`)
- **`clinicPortal.*`** file prefix for service/controller/routes/validator
- URL prefix **`/clinic`** — free, collides with nothing

Without this, `Clinic` (a location) and `ClinicProfile` (an account) become indistinguishable to every future reader.

---

## 1. Auth — do this FIRST, on its own

### 1.1 The hole

`services/auth.service.js:51-75`:
```js
const roleOk = allow === "admin" ? user?.role === ROLES.ADMIN
                                 : user && user.role !== ROLES.ADMIN;
```
The else-branch admits **anything that is not admin**. Add `clinic` to the enum and a clinic signs in at `POST /auth/login` — no `audience` needed — and gets a token `authorize(ROLES.CLINIC)` honours.

`googleAuth` (`:123-141`) is worse: the existing-user branch finds by `googleId` OR `email`, runs `assertAudience` (a no-op when the client omits `audience`), links and issues tokens. **No role check at all.**

### 1.2 The fix — allow-list, not a two-way flag

```js
async function verifyPasswordLogin({ email, password, audience }, allowedRoles, req) {
  const user = await userService.findByEmail(email, { withPassword: true });
  const roleOk = user && allowedRoles.includes(user.role);
  …
}

loginLocal  → verifyPasswordLogin(creds, [ROLES.DOCTOR, ROLES.PATIENT], req)
loginAdmin  → verifyPasswordLogin(creds, [ROLES.ADMIN], req)
loginClinic → verifyPasswordLogin(creds, [ROLES.CLINIC], req)   🔵
```

Every future role is now **denied by default at every endpoint** instead of admitted by default. Three-line diff; zero behaviour change for existing accounts.

Pass the same `allowedRoles` into `googleAuth`; `/auth/google` gets `[DOCTOR, PATIENT]`.

> Order matters: **ship this before migration 017.** Between the enum widening and this fix, the hole is live.

### 1.3 The full auth surface

Eleven auth endpoints exist. **Six need no change at all** — they never branch on role:

| Endpoint | Clinic support |
|---|---|
| `POST /auth/refresh` 🟢 | works — role-agnostic |
| `POST /auth/forgot-password` 🟢 | works — looks up by email only |
| `POST /auth/reset-password` 🟢 | works |
| `POST /auth/change-password` 🟢 | works — `authenticate` only |
| `GET /auth/me` 🟢 | works **once `profileInclude` has a clinic branch** (§1.4) |
| `POST /auth/logout` 🟢 | works |

Three need work:

| Endpoint | Change |
|---|---|
| `POST /auth/register` 🟡 | Add `CLINIC` to `SELF_REGISTERABLE_ROLES`. The Joi `role` at `auth.validator.js:33` derives from that constant, so it widens automatically. |
| `POST /auth/clinic/login` 🔵 | Password sign-in. Clone of `adminAuth.controller.js`, reusing `schema.login` unchanged, behind `authLimiter`. |
| `POST /auth/clinic/google` 🔵 | **Google sign-in AND first-time signup**, both through one route. |
| `PATCH /auth/profile` 🟡 | Add the `ROLES.CLINIC && patch.clinic` branch (`auth.service.js:256-261`) + a `clinic` object on `auth.validator.updateProfile`. |

### 1.3.1 Why dedicated routes rather than a wider `audience`

Do **not** add `"clinic"` to the `audience` whitelist (`auth.validator.js:49,58`).

`audience` does two jobs in `googleAuth`: it is the wrong-portal check (`assertAudience`, a **no-op when the client omits it**) and the signup role selector (`const signupRole = audience || role`, `:146`). Both are driven by a client-supplied string. Widening it would mean a clinic that simply *omits* `audience` on `/auth/google` gets a clinic session from the patient app — the exact hole §1.1 is closing, reintroduced through the side door.

**`POST /auth/clinic/google`** instead, calling `googleAuth(credential, { allowedRoles: [ROLES.CLINIC], signupRole: ROLES.CLINIC })`. The allowed role set is then a property of the **route**, decided server-side. `/auth/google` keeps `[DOCTOR, PATIENT]`.

Same principle as `/auth/clinic/login`: registration may share a route (creating a *new* account is not privilege escalation), but **signing in as an existing account must never depend on the client naming its own portal**.

### 1.4 The rest of the role wiring

| File | Change |
|---|---|
| `config/constants.js:7-11` | `CLINIC: "clinic"` in `ROLES` |
| `config/constants.js:14` | **Add `CLINIC` to `SELF_REGISTERABLE_ROLES`** — this is what makes `/auth/register` and Google signup accept it |
| `models/user.model.js:17` | No edit — `ENUM(...Object.values(ROLES))` widens automatically |
| `services/user.service.js:21-25` | `profileInclude` — clinic branch, else `GET /auth/me` returns a profile-less clinic |
| `services/user.service.js:41-52` | `createProfileRow` — clinic branch, else signup creates a user with **no profile row** (and both register paths silently produce a broken account) |
| `services/auth.service.js:256-261` | `updateProfile` — clinic branch |
| `.env` `CLIENT_URL` | Append the clinic origin. Comma-split at `app.js:33` — **no code change** |

### 1.5 Admin-created clinics (still useful)

`POST /admin/clinics` remains worth having alongside self sign-up, for clinics onboarded by the platform team. `adminDoctor.service.createDoctor:19-50` and a clinic equivalent would be ~90 % identical, so extract:

```js
userService.createAccount({ name, email, password, role, isEmailVerified, profileOverrides })
```

and have **both** call it (conventions rule 9). An admin-created clinic can be created pre-approved.

---

## 2. Migrations (latest on disk is 016)

### `017_clinic_role.sql` 🔵
```sql
ALTER TABLE users MODIFY role ENUM('patient','doctor','admin','clinic') NOT NULL;
CREATE TABLE IF NOT EXISTS clinic_profiles ( … );
```
The `ALTER` is **required**: `000_base_schema` is already recorded in `_migrations` and never re-runs, and `docs/dbstruct.md:23` hardcodes the three-value enum.

**`clinic_profiles` columns:**

| Column | Type | Note |
|---|---|---|
| `user_id` | BIGINT UNSIGNED PK/FK → `users(id)` | mirrors `doctor_profiles` |
| `clinic_name` | VARCHAR(150) | |
| `registration_number` | VARCHAR(100) NULL | licence / registration |
| `phone` | VARCHAR(20) NULL | |
| `address_line` | VARCHAR(255) NULL | |
| `city` · `state` · `pincode` | VARCHAR NULL | |
| **`lat` · `lng`** | DECIMAL(10,7) NULL | **the map location** — same precision as `clinics.lat/lng` so the existing picker and any future geo query work unchanged |
| `logo_url` | VARCHAR(512) NULL | |
| **`verification_status`** | ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending' | mirrors `doctor_profiles` (README §8-F) |
| **`is_submitted`** | BOOLEAN NOT NULL DEFAULT 0 | draft vs. submitted-for-review |
| `verification_notes` | VARCHAR(500) NULL | the admin's reason on reject |
| `is_active` | BOOLEAN NOT NULL DEFAULT 1 | |
| `created_at` · `updated_at` | DATETIME | |

Add `KEY idx_clinic_profiles_status (verification_status)` — the admin queue filters on it.

### `018_record_provenance.sql` 🔵
See §3.

### `019_booking_agency.sql` 🔵
`ALTER TABLE bookings ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL`, FK `users(id) ON DELETE SET NULL`. NULL = the patient booked it themselves, which is every existing row. See §6c.2.

### Dev-parity shims 🔵
`ensureClinicRoleEnum.js` and `ensureRecordProvenance.js`, called from `server.js` inside the `NODE_ENV === "development"` block — `sequelize.sync()` never ALTERs an existing table. Mirror `ensureDoctorListingToggle.js`.

Both migrations `information_schema`-guarded and idempotent, like 013–016.

---

## 3. Provenance — one shared pair across five tables

**Recommended: `source` + `recorded_by_user_id` on every record table.** Reuse the name `source` — `patient_vitals.source` already exists (`models/patientVitals.model.js:28`) — rather than inventing a parallel concept, so all four record types read identically.

*Rejected: a polymorphic author table.* It can't carry an FK, adds a join to four independent read paths, and turns a `WHERE` clause into a second round trip.

| Table | Change |
|---|---|
| `patient_vitals` | widen `source` → `ENUM('patient','doctor','clinic')`; add `recorded_by_user_id` |
| `uploaded_records` | add `source` (default `'patient'`) + `recorded_by_user_id` — **no uploader column exists today** |
| `patient_allergies` | add both |
| `patient_conditions` | add both |
| `clinical_notes` | add both, **and backfill** `recorded_by_user_id = doctor_id`, `source='doctor'` |

`recorded_by_user_id` FKs `users(id)` **`ON DELETE SET NULL`** — deleting a clinic account must never cascade-delete a medical record.

Add `RECORD_SOURCES = Object.freeze({ PATIENT:'patient', DOCTOR:'doctor', CLINIC:'clinic' })` to `config/constants.js`; no string literals anywhere else.

**The display name is just `users.name` of the author**, joined via `recordedByUserId`. No extra table, no denormalised clinic name.

### Because the patient CAN delete
No `source`-guarded delete paths are needed. The existing replace-the-set allergy write stays coherent: the patient's form lists *every* row (theirs and the clinic's), so saving preserves exactly what is displayed and anything removed was removed deliberately.

### ⚠️ Risk — the `author` association
`models/index.js:263` is `ClinicalNote.belongsTo(User, { foreignKey: "doctorId", as: "author" })`, consumed by `clinicalNote.service.js:17`, `careJourney.service.js:43` and `referral.service.js:205`.

Repointing `author` to `recordedByUserId` is correct — **but if the backfill does not run, every existing note's "Dr. X" label goes blank across the doctor app, the patient app, the journey view and the referral case view.**

Backfill inside the same migration *and* the shim. Lower-risk fallback: keep `author` on `doctorId`, add a second `recordedBy` association, and have `serializeClinicalNote` read `recordedBy ?? author` — costs one extra LEFT JOIN per note read.

---

## 4. Clinic-authored clinical notes have no booking

**The blocker:** `clinical_notes.booking_id` **is** already nullable (`models/clinicalNote.model.js:20`), but `doctor_id` is **`NOT NULL`** (`:19`) *and* carries `fk_clinical_notes_doctor → doctor_profiles(user_id)` (`009_clinical_notes.sql:45`). A clinic's `users.id` fails that FK even if the column were nullable.

**Minimal change:**

1. `ALTER TABLE clinical_notes MODIFY doctor_id BIGINT UNSIGNED NULL` (in `018`). The FK survives — MySQL permits NULL under an FK.
2. Model: `doctorId: { allowNull: true }` + the two provenance columns.
3. `models/index.js`: repoint `as: "author"` (see the risk above).
4. `services/clinicalNote.service.js` 🟡 — add:
   ```js
   createForPatient(patientId, clinicUserId, data)
     → { doctorId: null, bookingId: null, recordedByUserId: clinicUserId, source: 'clinic' }
   ```

**While in there, two extractions the file is asking for:**
- `listForBookingPatient:38` and `listForPatientBooking:59` duplicate the same `WHERE patientId` + `include:[withAuthor]` + `ORDER` query **verbatim**. Extract `listForPatient(patientId)` and have all three call it.
- The field mapping at `:73-89` becomes a private `noteRow(patientId, data, author)` — exactly the shape `patientVitals.service.js:27` `vitalsRow` already uses.

The doctor's booking-keyed path is untouched (it still passes `doctorId` + `bookingId`, `source:'doctor'`). The patient read path is patient-keyed already, so clinic notes surface with **zero change**.

> ### ⚠️ Contract consequence
> `treatmentTimeline.service.js:58` `attachConsultationArtifacts` filters notes by `bookingId IN (...)`. Clinic notes have `bookingId NULL`, so they will **never** appear as timeline rows.
>
> That is correct — the timeline's spine is `bookings` — but it means **both** the clinic's workspace and the patient's Records page must render clinic notes from the patient-keyed `listForPatient`, not from the timeline payload. State it in the API contract or it reads as "my note vanished".

---

## 5. Allergies & conditions — add-only, never replace

**Endpoint shape: `POST`, never `PUT`.**
```
POST /clinic/patients/:patientId/allergies    { items: [{ name, severity? }] }
POST /clinic/patients/:patientId/conditions   { items: [{ name, diagnosedYear? }] }
```
The replace verb is the entire reason clobbering is possible; removing it removes the failure mode structurally rather than by convention.

**Merge rule — add-only, existing rows untouched.** `patient_allergies` PK is composite `(patient_id, allergy_id)` (`models/patientAllergy.model.js:13-14`), so a clinic naming an allergy the patient already has is a **PK collision, not a duplicate row**:

- `bulkCreate(rows, { ignoreDuplicates: true })` — an already-present allergy keeps its original `source`, `severity` and author. Only genuinely new rows are stamped `source:'clinic'` + `recordedByUserId`.
- If ≥1 row was inserted, clear `no_known_allergies` / `no_known_conditions` on `patient_profiles` **in the same transaction** — otherwise the profile claims "no known allergies" while listing three.

**Where:** `addAllergiesFor(patientId, items, author)` / `addConditionsFor(...)` go **inside `services/patient.service.js`** 🟡, not a new service, so they reuse its existing `resolveLookupIds` helper (`:180`) — the bounded name→id resolver. Re-writing it would be exactly the copy-paste the conventions forbid.

**Accepted limitation:** a clinic cannot *correct* the severity of an allergy the patient already entered. That is the price of "never rewrite". An `ON DUPLICATE KEY UPDATE severity = COALESCE(new, old)` variant is one line if wanted — but it must **not** flip `source`.

---

## 6. The patient directory

```
GET /clinic/patients?q=&page=&pageSize=
```

**Put the query in `services/user.service.js` as `searchPatients({ q, page, pageSize })`** 🟡 — the conventions' designated home for reusable user queries, and the ONE place `role='patient' AND is_active=1` is expressed. This is the codebase's **first** `User.findAndCountAll`; keeping it in exactly one file is what stops a second, laxer copy appearing later.

- **WHERE:** `role: ROLES.PATIENT`, `isActive: true`; with `q`, `[Op.or]: [{ name: like }, { phone: like }]`. **Escape `%` and `_` in `q`** — Sequelize binds the value (no injection), but an unescaped `%` matches everything, which is a confusing result rather than a breach.
- **Eager-load `PatientProfile`** — a `hasOne`, so no fan-out and `count` stays correct without `distinct`. Never a per-row lookup.
- **Empty `q` is allowed** — the requirement is "browse all patients".
- **Row shape:** `id`, `name`, `avatarUrl`, `gender`, `age` (derived via `utils/age`), `city`.
- **Envelope:** copy `contact.service.js:47-53` verbatim so paging shapes don't drift.
- **Must NOT expose:** `email` (enumeration/spam), `passwordHash` (the `defaultScope` already excludes it — **never** reach for `User.scope("withPassword")` here), `googleId`, `isEmailVerified`, `addressLine`/`pincode`, and any medical field. Use a dedicated **`serializeClinicPatientRow`** 🔵 — *not* `serializeUser`, which returns `email`.
- **`phone` is searchable but not returned in list rows** — otherwise the endpoint is a reverse-phone lookup (type a number, get a name). It remains available in the detail view.
- `validateQuery`, **not** `validate` — Express 5's `req.query` has no setter.
- `CLINIC_PATIENT_PAGE_SIZE_DEFAULT = 20`, `_MAX = 50` in `constants.js`.
- `users` already has `KEY idx_users_role` (`docs/dbstruct.md:39`), so the role filter is indexed. `name LIKE '%q%'` cannot use an index — fine at current scale; FULLTEXT is the follow-up.

---

## 6b. Clinic profile, onboarding & approval 🔵

Mirrors the doctor flow (`services/verification.service.js`) rather than inventing a second pattern.

### `services/clinicOnboarding.service.js` 🔵

```js
computeChecklist(profile)   // the ONE definition of "what's done"
canSubmit(steps)            // every required step true
getOnboarding(userId)       // { steps, canSubmit, isSubmitted, verificationStatus, notes }
submit(userId)              // 422 ONBOARDING_INCOMPLETE, else flips is_submitted
reviewClinic(id, verdict)   // admin: approved | rejected + notes
```

Checklist steps (`CLINIC_ONBOARDING_STEPS` in constants — the completeness engine and the submit guard read the **same** list so they cannot drift):

| Step | Done when |
|---|---|
| `identity` | clinic name + phone |
| `registration` | a real registration number |
| `address` | address line + city + state + pincode |
| **`location`** | **`lat` and `lng` both set** — the map pin |
| `documents` | ≥1 verification document uploaded |

Profile completion for the UI bar reuses the weighted-sections shape of `patient.service.computeProfileCompletion` (`percent` = Σ done×weight).

### Verification gate 🔵

**`middlewares/requireApprovedClinic.js`** — 403 `CLINIC_NOT_APPROVED` unless `verification_status = 'approved'`.

Applied to **every `/clinic/patients*` route and nothing else**. A pending clinic can still sign in, complete its profile, upload documents and submit — it simply cannot reach patient data. Attaching it at the patient routes rather than app-wide is deliberate: the onboarding screens must remain reachable, or an unapproved clinic is locked out of the very thing it needs to do next.

### Admin queue 🔵
`routes/adminClinic.routes.js` — `GET /admin/clinics?status=`, `GET /admin/clinics/:id`, `POST /admin/clinics/:id/verify`. A near-exact clone of `adminDoctor.routes.js`; consider extracting the shared verdict handler.

---

## 6c. Booking on behalf of a patient 🔵

The clinic-as-medium flow. **Reuse `booking.service.create` — do not write a second booking path.** Everything that makes booking correct (slot re-validation through `resolveBookableSlot`, fee resolved from the doctor/clinic and never the client, the generated `active_lock_key` UNIQUE race guard, referral linking, the status lifecycle) must not be duplicated or it will drift.

### 6c.1 The signature already fits

```js
create(patientId, { doctorId, mode, clinicId, date, startTime, paymentMode, referralId })
```

`patientId` is already the **first parameter**, not `req.user.id` — so booking for someone else is a matter of *who supplies it*, plus attribution. Add an options bag rather than a parallel function:

```js
create(patientId, dto, { bookedByUserId = null } = {})
```

`bookedByUserId` is `null` for a patient booking their own consult (the overwhelming case, unchanged) and the clinic's `users.id` when a clinic books.

### 6c.2 Attribution — one column

`bookings` gains **`booked_by_user_id`** BIGINT UNSIGNED NULL, FK `users(id) ON DELETE SET NULL` (migration `019`). NULL means the patient booked it themselves.

No `booked_by_role` column: the role is `users.role` on the joined row, and denormalising it invites the two copies disagreeing. The display name is `users.name`, same as the record provenance in §3.

**Serializers** 🟡 — both sides must show it:
- `serializeBookingForDoctor` (`serializers.js:229`) → `bookedBy: { id, name, role } | null` — *"Booked by City Clinic"* on the appointment card and detail.
- `serializeBookingForPatient` → the same. A patient must never wonder where an appointment came from.

### 6c.3 Doctor & slot discovery — zero backend work 🟢

The clinic needs to find a doctor and a free slot. Both endpoints are **already public**:

| | |
|---|---|
| `GET /doctors` | discovery: search, specialty, city, video/clinic, paging |
| `GET /doctors/:id/slots?mode=&clinicId=&date=` | free slots |

They are unauthenticated (`doctorsPublic.routes.js`), so the clinic app calls them directly. Nothing to add.

> Reminder from `docs-shared/feature-plans/treatment-timeline`: those endpoints are gated on `verification_status='approved' AND is_listed=1`, so a clinic can only book doctors who are genuinely live — the same set a patient sees.

### 6c.4 ⚠️ Two existing rules collide with this flow

**Payment for video (README §8-G).** `create:109`:
```js
const finalPaymentMode = mode === BOOKING_MODES.VIDEO ? "online" : paymentMode;
```
Video is hard-forced to online → Razorpay → **the clinic cannot pay on the patient's card**. In-clinic is fine (offline confirms immediately with `payment.status='pending_at_clinic'`, and the doctor later marks it paid).

If option (a) is chosen, the change is narrow and should be written as such — *not* a blanket relaxation:
```js
const finalPaymentMode =
  mode === BOOKING_MODES.VIDEO && !bookedByUserId ? "online" : paymentMode;
```
i.e. a video consult is still always prepaid **unless a clinic booked it**, in which case the clinic collects. Settlement then needs a decision: `PLATFORM_COMMISSION_PCT` (`constants.js`) currently only splits on a successful *online* payment.

**Profile completeness (README §8-H).** `create:105` calls `assertProfileComplete(patientId)` — phone, DOB, gender, city. A walk-in may have none.

If option (a) is chosen: `PATCH /clinic/patients/:patientId/profile` 🔵 limited to **exactly those four fields** — reusing `patient.service.updateProfile`'s field whitelist, not a new one. Narrow by construction, so it cannot become a general patient-identity write.

### 6c.5 Prescription attribution — free, no new column

A prescription belongs to a booking (`prescriptions.booking_id`), and the booking now carries `booked_by_user_id`. So *"consulted Dr. X via Y Clinic"* is the **same join that already resolves the doctor** — there is nothing to add to `prescriptions`, and nothing changes about how one is written, finalized or rendered.

Serializers that gain it 🟡:
- `serializePrescriptionForPatient` — the patient's Prescriptions list and detail
- `serializeTimelineRow` (`docs-shared/feature-plans/treatment-timeline`) — the timeline row already loads the booking, so `bookedBy` comes off the same object
- `serializeBookingForPatient` — the Appointments page

The doctor's prescription flow is **untouched**: same composer, same finalize, same PDF. Only the patient-facing read gains a line.

> Include `booked_by_user_id` in the timeline's booking `attributes` and add the `bookedBy` user to `spineInclude` — otherwise the field silently serializes as `null` and the feature looks broken rather than unimplemented.

### 6c.6 Cancellation

`POST /clinic/patients/:patientId/bookings/:id/cancel` — the clinic can cancel a booking **it created** (`booked_by_user_id = <this clinic>`), not any booking of that patient. `booking.service.cancel` is keyed on `patientId`, so it needs the same options-bag treatment: assert the actor either owns the booking as the patient *or* created it.

---

## 7. Route surface

Mounted `router.use("/clinic", clinicPortalRoutes)` in `routes/index.js`.

**New middleware `middlewares/resolveClinicPatient.js`** 🔵 — mirrors `resolveDoctorId.js`: 404s unless `:patientId` is an existing, **active**, `role='patient'` user, then sets `req.patientId`.

Deliberately **existence-only**. `treatmentTimeline.listByPatient` asserts a *treating booking*; a clinic has no such relationship by design (README §3). Building it as middleware anyway gives the future clinic↔patient-link phase exactly **one** place to tighten.

```js
const guard     = [authenticate, authorize(ROLES.CLINIC)];              // profile + onboarding
const onPatient = [...guard, requireApprovedClinic, resolveClinicPatient]; // patient data
```

**The approval gate sits on `onPatient` only.** `guard` alone keeps the profile and onboarding routes reachable while a clinic is still pending.

| Method + path | Gate | Reuses |
|---|---|---|
| `POST /auth/register` `{role:"clinic"}` | public 🟢 | `SELF_REGISTERABLE_ROLES` |
| `POST /auth/clinic/login` | public + `authLimiter` | `loginClinic` |
| `POST /auth/clinic/google` | public | `googleAuth(…, [ROLES.CLINIC])` |
| `GET` / `PATCH` `/clinic/profile` | guard | `clinicPortal.service` |
| `GET /clinic/onboarding` | guard | `clinicOnboarding.getOnboarding` |
| `POST /clinic/submit` | guard | `clinicOnboarding.submit` |
| `POST` / `DELETE` `/clinic/documents` | guard + `upload.single("file")` | `uploadService` 🟢 |
| `GET /clinic/patients` | **onPatient** + `validateQuery` | §6 |
| `GET /clinic/patients/:patientId` | onPatient | `serializePatientSnapshot` 🟢 (already omits email) |
| `GET /clinic/patients/:patientId/timeline` | onPatient + `validateQuery(timelineSchema.listTimeline)` | **new thin export** wrapping `treatmentTimeline`'s private `assemble()` — do **not** reuse `listByPatient`, it asserts a booking |
| `GET .../vitals` | onPatient | `patientVitals.listForPatient` 🟢 — **zero new service code** |
| `GET .../records` | onPatient | `patient.service.getRecords` 🟢 |
| `GET .../allergies` · `.../conditions` | onPatient | `getAllergies` / `getConditions` 🟢 |
| `GET .../clinical-notes` | onPatient | `listForPatient` §4 |
| `POST .../vitals` | onPatient + `validate(patientSchema.addVitalsEntry)` | existing schema unchanged — its `location` field is natural for a clinic |
| `POST .../records` | onPatient + `validate(patientSchema.addRecord)` | paste-a-URL |
| `POST .../records/upload` | onPatient + `upload.single("file")` **before** `validate` | `patient.service.uploadRecord`, keyPrefix `clinic/{clinicId}/patients/{patientId}` |
| `POST .../allergies` · `.../conditions` | onPatient + `validate(clinicPortalSchema.*)` | §5 |
| `POST .../clinical-notes` | onPatient + `validate(clinicalNoteSchema.createNote)` | §4 `createForPatient` |
| `GET .../bookings` | onPatient | that patient's appointments |
| `POST .../bookings` | onPatient + `validate(clinicPortalSchema.createBooking)` | **§6c** `booking.service.create(patientId, dto, { bookedByUserId })` |
| `POST .../bookings/:id/cancel` | onPatient | §6c.5 — only bookings this clinic created |
| `PATCH .../profile` | onPatient + `validate` | §6c.4 — **only** phone/DOB/gender/city, per README §8-H |
| `GET /doctors` · `GET /doctors/:id/slots` | **public** 🟢 | doctor + slot discovery — **zero backend work** |

**No `DELETE` routes for the clinic in v1** — clinic-written records are append-only from the clinic's side, mirroring the doctor's notes.

**Requirement "each section independent" falls out for free.** Every write above is its own POST to its own table. There is no composite endpoint and therefore no all-or-nothing gate to remove. The only cross-field rule in play is the *existing* "at least one vital" check (`patient.validator.js:122-129`), which is within-section and stays.

---

## 8. Performance

| Path | Budget |
|---|---|
| `GET /clinic/patients` | 1 `findAndCountAll` with a `hasOne` include. No N+1. |
| `GET .../timeline` | 4 statements, unchanged from `treatmentTimeline` 🟢 |
| Every other read | 1 statement over an existing patient-keyed service |
| `POST .../allergies` | `resolveLookupIds` (≤3 bounded queries) + 1 `bulkCreate` + 1 profile update, all in one transaction |

No `await` inside a loop anywhere.

---

## 9. Test plan

| Area | Cases |
|---|---|
| **Auth boundary** | clinic → `POST /auth/login` **rejected** · clinic → `/auth/google` **rejected** · clinic → `/auth/clinic/login` **accepted** · patient/doctor/admin → `/auth/clinic/login` **rejected** · patient/doctor → `/auth/clinic/google` **rejected** |
| Registration | `/auth/register` with `role:"clinic"` creates the user **and** a `clinic_profiles` row · Google signup on `/auth/clinic/google` does the same · a Google signup lands `verification_status='pending'` |
| Password reset | forgot → reset works for a clinic with no code change |
| **Approval gate** | pending clinic → `/clinic/profile` **200**, `/clinic/onboarding` **200**, `/clinic/patients` **403 CLINIC_NOT_APPROVED** · after admin approval → **200** |
| Onboarding | `submit` 422s until every required step passes · **`location` is not satisfied by an address alone — `lat`+`lng` must both be set** |
| Role guard | patient token and doctor token each get **403** on every `/clinic/*` route |
| Directory | no `email` in any row · `q` with `%`/`_` behaves literally · empty `q` browses · `pageSize` clamped to 50 |
| `resolveClinicPatient` | unknown id → 404 · a doctor's id → 404 · an inactive patient → 404 |
| Provenance | each of the four writes lands with `source:'clinic'` and the right `recorded_by_user_id` |
| Allergies | clinic adds a name the patient already has → **no duplicate, original row untouched** · `no_known_allergies` cleared when a row is inserted |
| Notes | clinic note saves with `doctor_id NULL` · doctor booking-keyed write unchanged · **backfill: existing notes still resolve their author** |
| Independence | posting only vitals succeeds with every other section untouched |
| Patient side | patient sees all four with a source label · patient can delete a clinic row |
| **Booking on behalf** | clinic books an **in-clinic** consult → confirmed, `booked_by_user_id` set · clinic books a **video** consult → per §8-G · slot already taken → 409 `SLOT_TAKEN` (the lock key, not a check-then-write) · past slot → 422 |
| Booking attribution | the **doctor** sees "Booked by City Clinic" on the card *and* the detail · the **patient** sees it on their own Appointments page |
| Booking isolation | a patient booking their own consult still has `booked_by_user_id: null` and is unchanged end to end |
| Cancellation | clinic cancels a booking **it created** → ok · clinic cancels a booking the **patient** created → 404 |
| Profile gate | booking a patient with an incomplete profile behaves per §8-H |
