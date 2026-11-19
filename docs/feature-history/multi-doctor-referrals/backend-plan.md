# Backend Plan — Multi-Doctor Referrals & Care Journey

**App:** `backend/` (Node/Express/Sequelize). **Legend:** 🟢 existed · 🟡 extended · 🔵 new.

All doctor FKs point at `doctor_profiles.user_id` (== `users.id` for that doctor), exactly like `bookings` / `prescriptions` / `clinical_notes`. Patient FKs point at `users.id`. This plan reflects the **recommended** design from `README.md §9.1` (an explicit `care_journeys` table); the edges-only variant drops §1's first table and §4's journey model, and moves journey assembly to a graph walk over `referrals` (noted inline where it differs).

---

## 1. `db/migrations/011_referrals.sql` (🔵)

```sql
-- ── 20. CARE JOURNEYS  ==>  (1:M) patient -> many episodes of care ──────────────
CREATE TABLE IF NOT EXISTS care_journeys (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id       BIGINT UNSIGNED NOT NULL,          -- users.id
    origin_doctor_id BIGINT UNSIGNED NULL,              -- doctor who opened the episode
    origin_clinic_id BIGINT UNSIGNED NULL,              -- where it started (NULL = video)
    title            VARCHAR(200) NULL,                 -- "Back pain, Jul 2026" (editable)
    status           ENUM('open','closed') NOT NULL DEFAULT 'open',
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_care_journeys_patient (patient_id, created_at),
    CONSTRAINT fk_journey_patient FOREIGN KEY (patient_id)      REFERENCES users(id)                ON DELETE CASCADE,
    CONSTRAINT fk_journey_doctor  FOREIGN KEY (origin_doctor_id) REFERENCES doctor_profiles(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_journey_clinic  FOREIGN KEY (origin_clinic_id) REFERENCES clinics(id)             ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── 21. REFERRALS  ==>  (M:1 journey) directed edge  Dr A ──▶ Dr B ──────────────
CREATE TABLE IF NOT EXISTS referrals (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    journey_id        BIGINT UNSIGNED NOT NULL,
    patient_id        BIGINT UNSIGNED NOT NULL,          -- users.id (denormalized for the inbox query)
    from_doctor_id    BIGINT UNSIGNED NOT NULL,          -- doctor_profiles.user_id (referrer)
    to_doctor_id      BIGINT UNSIGNED NOT NULL,          -- doctor_profiles.user_id (referee)
    source_booking_id BIGINT UNSIGNED NOT NULL,          -- A's appt where the referral was made
    target_booking_id BIGINT UNSIGNED NULL,              -- B's appt, set once the patient books B
    reason            VARCHAR(500) NOT NULL,             -- why refer (shown to patient + B)
    note              VARCHAR(1000) NULL,                -- optional extra clinical note to B
    status            ENUM('pending','booked','completed','cancelled','declined')
                        NOT NULL DEFAULT 'pending',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_referral_journey (journey_id),
    INDEX idx_referral_to_pending (to_doctor_id, status),
    INDEX idx_referral_patient (patient_id, status),
    CONSTRAINT fk_referral_journey FOREIGN KEY (journey_id)        REFERENCES care_journeys(id)        ON DELETE CASCADE,
    CONSTRAINT fk_referral_patient FOREIGN KEY (patient_id)        REFERENCES users(id)                ON DELETE CASCADE,
    CONSTRAINT fk_referral_from    FOREIGN KEY (from_doctor_id)    REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_referral_to      FOREIGN KEY (to_doctor_id)      REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_referral_source  FOREIGN KEY (source_booking_id) REFERENCES bookings(id)             ON DELETE CASCADE,
    CONSTRAINT fk_referral_target  FOREIGN KEY (target_booking_id) REFERENCES bookings(id)             ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── bookings: +2 nullable links (idempotent — guarded for re-run) ───────────────
-- MySQL has no "ADD COLUMN IF NOT EXISTS"; the runner wraps these so a second
-- `npm run migrate` is a no-op (mirrors how earlier migrations guard ALTERs).
ALTER TABLE bookings ADD COLUMN journey_id  BIGINT UNSIGNED NULL AFTER clinic_id;
ALTER TABLE bookings ADD COLUMN referral_id BIGINT UNSIGNED NULL AFTER journey_id;
ALTER TABLE bookings ADD CONSTRAINT fk_booking_journey  FOREIGN KEY (journey_id)  REFERENCES care_journeys(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD CONSTRAINT fk_booking_referral FOREIGN KEY (referral_id) REFERENCES referrals(id)     ON DELETE SET NULL;
CREATE INDEX idx_booking_journey ON bookings (journey_id);
```

**FK delete semantics.** A journey `CASCADE`s its referrals (delete the episode → its edges go). `source_booking_id CASCADE` (the edge is meaningless without the consult that created it) but `target_booking_id SET NULL` (a fulfilled booking may be cancelled without erasing the referral fact). `origin_*` on the journey are `SET NULL` so a deleted doctor/clinic doesn't wipe a patient's history. `bookings.journey_id/referral_id` are `SET NULL` — the booking outlives the grouping.

**Runner.** `db/migrate.js` tracks applied files in `_migrations`, so `npm run migrate` applies **only 011**. The `ALTER … ADD COLUMN/CONSTRAINT` and `CREATE INDEX` statements are wrapped with existence checks (`information_schema.columns` / `.table_constraints` / `.statistics`) exactly as the earlier guarded migrations do, so re-running is safe.

## 2. `db/ensureReferralColumns.js` (🔵) + `server.js` (🟡)

Dev boot shim (mirrors `ensureClinicalNoteVitals` / `ensurePatientProfileColumns`): on start, `ALTER TABLE bookings ADD COLUMN … IF the column is absent` for `journey_id` / `referral_id`, so a dev DB kept in sync by `sequelize.sync()` gains the columns without a manual migrate. Fresh installs get them from migration 011. `server.js` calls it in the same boot block as the existing ensure-shims.

## 3. Models (🔵)

**`models/careJourney.model.js`** — `sequelize.define("CareJourney", { patientId, originDoctorId, originClinicId, title, status }, { tableName: "care_journeys", underscored: true })`. `status` default `"open"`.

**`models/referral.model.js`** — `sequelize.define("Referral", { journeyId, patientId, fromDoctorId, toDoctorId, sourceBookingId, targetBookingId, reason, note, status }, { tableName: "referrals", underscored: true })`. Global `underscored: true` maps `fromDoctorId → from_doctor_id`, etc.

**`models/booking.model.js`** (🟡) — add `journeyId` and `referralId` attributes (both `BIGINT`, `allowNull: true`).

## 4. `models/index.js` (🟡)

```js
// A patient has many care journeys; a journey has many bookings + many referral edges.
User.hasMany(CareJourney, { foreignKey: "patientId", as: "careJourneys", onDelete: "CASCADE" });
CareJourney.belongsTo(User, { foreignKey: "patientId", as: "patient" });
CareJourney.belongsTo(DoctorProfile, { foreignKey: "originDoctorId", as: "originDoctor" });
CareJourney.belongsTo(Clinic, { foreignKey: "originClinicId", as: "originClinic" });

CareJourney.hasMany(Booking, { foreignKey: "journeyId", as: "consultations" });
Booking.belongsTo(CareJourney, { foreignKey: "journeyId", as: "journey" });

CareJourney.hasMany(Referral, { foreignKey: "journeyId", as: "referrals", onDelete: "CASCADE" });
Referral.belongsTo(CareJourney, { foreignKey: "journeyId", as: "journey" });

// A referral: patient + from/to doctor + source/target booking. Two DoctorProfile
// belongsTo need distinct aliases; two Booking belongsTo likewise.
Referral.belongsTo(User, { foreignKey: "patientId", as: "patient" });
Referral.belongsTo(DoctorProfile, { foreignKey: "fromDoctorId", as: "fromDoctor" });
Referral.belongsTo(DoctorProfile, { foreignKey: "toDoctorId", as: "toDoctor" });
Referral.belongsTo(Booking, { foreignKey: "sourceBookingId", as: "sourceBooking" });
Referral.belongsTo(Booking, { foreignKey: "targetBookingId", as: "targetBooking" });

// The booking that fulfils a referral (the "incoming" edge for that consult).
Booking.belongsTo(Referral, { foreignKey: "referralId", as: "incomingReferral" });
```

Plus the three `require`s and the `module.exports` additions (`CareJourney`, `Referral`).

## 5. `config/constants.js` (🟡)

```js
REFERRAL_STATUS = { PENDING: "pending", BOOKED: "booked", COMPLETED: "completed",
                    CANCELLED: "cancelled", DECLINED: "declined" };
JOURNEY_STATUS  = { OPEN: "open", CLOSED: "closed" };
REFERRAL_TARGET_LIMIT = 8;   // autocomplete page size
// ERROR_CODES additions:
REFERRAL_NOT_FOUND, REFERRAL_TARGET_INVALID (self / not approved),
REFERRAL_NOT_CANCELLABLE (already booked/completed), REFERRAL_ALREADY_LINKED,
JOURNEY_NOT_FOUND
```

## 6. Validators

**`validators/referral.validator.js`** (🔵)
- `createReferral` (body): `toDoctorId` `Joi.number().integer().positive().required()`; `reason` `Joi.string().trim().min(3).max(500).required()`; `note` `Joi.string().trim().max(1000).allow("", null)`.
- `listTargets` (query): `q` `Joi.string().trim().min(1).max(80).required()`; `clinicId` `Joi.number().integer().positive().optional()`.
- `cancelReferral` (body): `status` `Joi.string().valid("cancelled").required()` (PATCH is cancel-only for MVP).

**`validators/booking.validator.js`** (🟡) — `createBooking` gains `referralId Joi.number().integer().positive().optional()`. Everything else unchanged.

## 7. `services/referral.service.js` (🔵)

The gate (identical rule to `clinicalNote.service.assertBookingUnlocked`) + the operations.

```js
const UNLOCKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];

async function assertOwnedUnlocked(doctorId, bookingId) {
  const booking = await Booking.findOne({
    where: { id: bookingId, doctorId },
    attributes: ["id", "patientId", "clinicId", "status", "journeyId"],
  });
  if (!booking) throw ApiError.notFound("Booking not found");            // not owned / unknown
  if (!UNLOCKED.includes(booking.status))
    throw ApiError.forbidden("Refer once the booking is confirmed");
  return booking;
}
```

**`createFromBooking(fromDoctorId, bookingId, { toDoctorId, reason, note })`**
1. `booking = assertOwnedUnlocked(fromDoctorId, bookingId)`.
2. Validate the target: `toDoctorId !== fromDoctorId` and the target is an **approved, active** doctor — else `REFERRAL_TARGET_INVALID` (422). (One `DoctorProfile.findOne` with `verificationStatus: 'approved'` joined to `users.is_active`.)
3. **Lazy journey:** if `booking.journeyId` is null, create a `CareJourney` (`patientId = booking.patientId`, `originDoctorId = fromDoctorId`, `originClinicId = booking.clinicId`, `title = <source diagnosis || reason>`), then set `booking.journeyId` and save. All of steps 3–4 run in **one `sequelize.transaction`** so a journey is never orphaned.
4. Create the `Referral` (`journeyId`, `patientId`, `fromDoctorId`, `toDoctorId`, `sourceBookingId = booking.id`, `reason`, `note`, `status = pending`).
5. Return the referral with `fromDoctor`/`toDoctor` (+ their `user.name`) for serialization.

**`listForBookingPatient(doctorId, bookingId)`** — `assertOwnedUnlocked`, then referrals where `source_booking_id = bookingId` (what *this* doctor referred from this consult), newest first, with `toDoctor`. *(A separate read — "who referred this patient TO me" — is the `pending` referrals where `to_doctor_id = doctorId AND patient_id = booking.patientId`; surfaced to Dr. B so they see A's reason. Optional for MVP; folded into the same controller if wanted.)*

**`listTargets(fromDoctorId, { q, clinicId })`** — the autocomplete. Reuse the `doctorSearch` pattern: a single parameterized SQL over `doctor_profiles p JOIN users u`, `WHERE p.verification_status='approved' AND u.is_active=1 AND p.user_id <> :self AND u.name LIKE :q`, `LIMIT REFERRAL_TARGET_LIMIT`. For **Decision §9.2 (b)** ("same clinic first"), when `clinicId` is passed, resolve the source clinic's `name`+`city` and add an ordering column `EXISTS(same-name-city active clinic) DESC` before `u.name`. Returns `{ id, name, photo, specializations, primaryClinic }` rows (hydrate like `doctorSearch.hydrate`, or select the display columns directly — the set is ≤ 8).

**`cancel(fromDoctorId, referralId)`** — load the referral scoped to `from_doctor_id = fromDoctorId`; 404 if not found. Only `status === pending` is cancellable (else `REFERRAL_NOT_CANCELLABLE`, 409). Set `status = cancelled`.

**`startConsultation(doctorId, referralId)`** — the **in-clinic walk-in**. The target doctor begins consulting the patient who walked over from the referrer, so there's no separate patient booking:
1. Load the referral scoped to `to_doctor_id = doctorId`; 404 if not found. If `target_booking_id` is already set (patient booked online, or a double-click), **return it — idempotent**. Reject if the referral isn't `pending`/`booked` (`REFERRAL_NOT_CANCELLABLE`, 409).
2. Resolve the clinic: the target doctor's own first active clinic (clinics are doctor-owned; in the "one clinic, many doctors" case its name+city match the referrer's), falling back to the source booking's clinic.
3. In one transaction, create **the target doctor's ₹0 booking** (`status='confirmed'`, `booking_type='offline'`, `amount=0`, a "now"-to-the-second slot so the generated `active_lock_key` can't collide, `journey_id`+`referral_id` stamped) + a settled **₹0 `Payment`** (`success`; commission/payout default to `0.00`, == `applySplit` of ₹0, so the 1:1 booking↔payment invariant holds), then flip the referral to `booked` with `target_booking_id` set. A `SequelizeUniqueConstraintError` maps to `SLOT_TAKEN` (409).
3. Return `{ bookingId }` so the UI opens the ordinary appointment screen. **One booking, one fee** — the visit was already paid on the referring appointment (`README.md §9.3`).

**`linkBooking(booking, referralId, tx)`** — called by `booking.service` **inside the booking-create transaction**:
1. Load the referral; must exist, belong to **this patient** (`referral.patientId === booking.patientId`), target **this doctor** (`referral.toDoctorId === booking.doctorId`), and be `pending` (else `REFERRAL_ALREADY_LINKED`, 409).
2. Set `booking.journeyId = referral.journeyId`, `booking.referralId = referral.id`.
3. Set `referral.targetBookingId = booking.id`, `referral.status = 'booked'`.

**`completeForBooking(booking, tx)`** — called by `booking.service.complete` (inside its tx, `!noShow`). Flips the completed consult's own incoming referral `booked → completed`; then, if this is the **terminal** consult of its journey (no onward `pending`/`booked` referral from it, and no `pending` referral anywhere in the journey), **cascades**: bulk-updates every `confirmed` consult in the journey → `completed`, every `pending`/`booked` referral → `completed`, and the journey → `closed`. This is what makes `A→B→C→D` finish for **all four doctors** the moment D completes (the walk-in intermediaries never mark complete themselves). Bulk status only — no other booking's payment is settled.

## 8. `services/careJourney.service.js` (🔵) — the assembler

**`listForPatient(patientId)`** — journeys for the patient, newest first, each with a cheap summary: consultation count, distinct doctor count, and last activity. Plus the patient's **pending referral inbox** (referrals where `patient_id = patientId AND status = 'pending'`, with `fromDoctor`/`toDoctor` + the target doctor's `slug` for the book deep-link).

**`getForPatient(patientId, journeyId)`** — the full episode, ownership as a `WHERE` (404 if not the patient's):
1. The `CareJourney` (`originDoctor`, `originClinic`).
2. Its **consultations** = `Booking.findAll WHERE journey_id = journeyId`, ordered by `slot_date, slot_start_time`, each including `doctor→user` (name/photo/specialty) and `clinic`.
3. For each consultation, join in that doctor's **reports** (`ClinicalNote WHERE patient_id = journey.patientId AND booking_id = booking.id`) and its **prescription** (the newest non-superseded `Prescription WHERE booking_id = booking.id`, finalized). *(Notes/Rx models already exist — this is a read, not a new store.)*
4. The **edges** = `Referral WHERE journey_id = journeyId`, giving `sourceBookingId → targetBookingId` + reason, so the frontend can draw the arrows between consultations.

Return a shape the serializer turns into `JourneyDetail` (see `integration-plan.md §2`). No N+1: batch the notes/Rx reads with `WHERE booking_id IN (...)` and group in memory (per the `backend-conventions` "no queries in loops" rule).

*(Edges-only variant: replace steps 1–2 with "find the connected component of `referrals` reachable from the seed booking, collect its booking ids, order by date" — same steps 3–4 downstream.)*

## 9. `services/booking.service.js` (🟡)

The only change to the existing create path: after the booking row is created **within its transaction**, if the request carried `referralId`, call `referralService.linkBooking(booking, referralId, tx)`. If `linkBooking` throws (bad/mismatched/already-linked referral), the transaction rolls back — the booking is **not** created with a dangling link. When `referralId` is absent, behaviour is byte-for-byte what it is today.

## 10. Controllers (🔵) + Routes (🟡)

**`controllers/doctorReferral.controller.js`** — thin: `create` → `created(res, serializeReferral(...))`; `listForBooking` → `ok(res, rows.map(serializeReferral))`; `listTargets` → `ok(res, rows.map(serializeReferralTarget))`; `cancel` → `ok(res, serializeReferral(...))`.

**`controllers/patientJourney.controller.js`** — `list` → `ok(res, { journeys, pendingReferrals })`; `getOne` → `ok(res, serializeJourneyDetail(...))`.

**Routes** (all under the existing guards):
```js
// routes/doctorBooking.routes.js  (guard = authenticate, authorize('doctor'), resolveDoctorId('self'))
router.post("/bookings/:id/referrals", ...guard, validate(referralSchema.createReferral), referral.create);
router.get ("/bookings/:id/referrals", ...guard, referral.listForBooking);

// routes/doctor.routes.js
router.get  ("/referral-targets", ...guard, validateQuery(referralSchema.listTargets), referral.listTargets);
router.patch("/referrals/:id",    ...guard, validate(referralSchema.cancelReferral),  referral.cancel);

// routes/patient.routes.js  (patient guard)
router.get("/journeys",     ...patientGuard, journey.list);
router.get("/journeys/:id", ...patientGuard, journey.getOne);
```

`resolveDoctorId('self')` means `req.doctorId` is the token's user id — ownership (`from_doctor_id = req.doctorId`, `booking.doctorId = req.doctorId`) is always a `WHERE`, never a post-load `if`, matching `clinicalNote.service` / `clinic.service`.

## 11. `utils/serializers.js` (🟡)

```js
serializeReferral(r) → {
  id, journeyId, status, reason, note,
  fromDoctor: { id, name },  toDoctor: { id, name, slug, specialization, photo },
  sourceBookingId, targetBookingId, createdAt
}
serializeReferralTarget(d) → { id, name, photo, specializations: string[], clinicName, sameClinic: bool }
serializeJourneySummary(j) → { id, title, status, doctorCount, consultationCount, lastActivityAt, createdAt }
serializeJourneyDetail(j) → {
  ...summary,
  consultations: [{ bookingId, date, status, doctor:{id,name,slug,photo,specialization},
                    clinic:{id,name}|null, reports: ClinicalNote[], prescription: RxSummary|null }],
  edges: [{ referralId, fromBookingId, toBookingId|null, reason, status }]
}
```
`serializeReferral`/`serializeJourneyDetail` reuse the existing `serializeClinicalNote` and the prescription summary serializer verbatim — the journey adds structure, not new field shapes.

## 12. Why these choices (the design decisions in one place)

- **A `referrals` table, not a status column on `bookings`.** A referral has its own facts (who/whom/why/when/acted-on) and its own lifecycle; those belong to the edge, not to either endpoint booking.
- **`care_journeys` as the recommended grouping.** The headline requirement is the patient's *whole-flow* view; giving it a first-class, titled, single-id row makes the read one indexed query and gives the episode a place to carry title + open/closed. The edges-only alternative is documented for a lighter build (`README.md §9.1`).
- **`journey_id` + `referral_id` denormalized onto `bookings`.** So the journey read never walks a graph; both are nullable `SET NULL` links, so a booking is never blocked by the feature.
- **Reuse, not re-store.** Reports = `clinical_notes` (already patient-wide + patient-readable), prescriptions = `prescriptions` (already per-booking + patient-downloadable). This feature is a **linker and a lens**, so its whole surface is one migration + one service pair + serializers.
- **The gate is the one already in production.** "Own confirmed/completed booking" (from `clinical_notes`) is reused verbatim for creating a referral, so authorization stays consistent and an unpaid hold leaks nothing.
