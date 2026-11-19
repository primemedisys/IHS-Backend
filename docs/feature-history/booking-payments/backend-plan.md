# Backend — Booking & Payments

**Stack:** Node.js + **Express 5** + **Sequelize 6** + **mysql2**, CommonJS, **Joi** validation. This extends the built clinics/availability feature under `backend/src/`. The layered flow is non-negotiable (`.claude/skills/backend-conventions`):

```
route → validate(joiSchema) → authenticate → authorize(role) → controller → service → model
```

Read `README.md` first (scope, gates, state machine, endpoint catalog). **Legend:** 🟢 exists · 🟡 extend · 🔵 new. **Tables are created two ways:** dev = `sequelize.sync()` from the models; prod = the forward-only SQL migration. So every new table needs **both** a model (§2) **and** a matching migration (§1) — same as `002`/`003` did.

---

## 1. Migration — `src/db/migrations/005_bookings_payments.sql` 🔵

Forward-only, idempotent (`CREATE TABLE IF NOT EXISTS`), applied by `npm run migrate` (tracked in `_migrations`, same runner as `003`/`004`; safe alongside dev `sequelize.sync()`). Lift the two tables **verbatim** from `docs/dbstruct.md §12–13` so the hand-written schema stays the source of truth.

```sql
USE clinic_platform;

CREATE TABLE IF NOT EXISTS bookings ( ... );   -- dbstruct.md §12  (incl. the generated active_lock_key + uq_booking_doctor_slot_lock)
CREATE TABLE IF NOT EXISTS payments ( ... );   -- dbstruct.md §13
```

**Critical — copy these exactly, they are the whole race-safety story:**
- `active_lock_key VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN status IN ('pending_payment','confirmed') THEN CONCAT(doctor_id,'_',slot_date,'_',slot_start_time) ELSE NULL END) STORED` + `UNIQUE KEY uq_booking_doctor_slot_lock (active_lock_key)`. This is what makes two patients booking the same slot impossible at the DB layer (PRD §8). MySQL treats multiple `NULL`s as non-conflicting, so cancelled/completed rows drop out of the unique index for free.
- All FKs (`patient_id→users`, `doctor_id→doctor_profiles.user_id`, `clinic_id→clinics` nullable, `family_member_id→family_members` nullable), and indexes `idx_booking_patient`, `idx_booking_doctor_date`, `idx_booking_status`.
- `payments`: `uq_payment_booking (booking_id)` (1:1), the razorpay id columns, `commission_amount`, `doctor_payout_amount`, `idx_payment_status`.

> `family_members` (`dbstruct.md §3`) is referenced by `bookings.family_member_id`. If that table isn't migrated yet, add its `CREATE TABLE IF NOT EXISTS` here too (the column is nullable and unused in MVP, but the FK needs its target to exist). Verify after: `SHOW TABLES` includes `bookings`, `payments`; `npm run migrate` twice is a no-op the second time; `SHOW CREATE TABLE bookings` shows the generated column + unique key.

---

## 2. Models 🔵 (+ 🟡 `models/index.js`)

camelCase field → snake_case column (`underscored: true`, matching `clinic.model.js`).

| File | Table | Key fields |
|---|---|---|
| `booking.model.js` 🔵 | `bookings` | `id, patientId, familyMemberId, doctorId, clinicId, bookingType, slotDate, slotStartTime, slotEndTime, status, paymentMode, amount, meetLink, meetEventId, cancelledReason` |
| `payment.model.js` 🔵 | `payments` | `id, bookingId, amount, mode, status, razorpayOrderId, razorpayPaymentId, razorpaySignature, commissionAmount, doctorPayoutAmount, paidAt` |

> Do **not** declare `activeLockKey` as a writable attribute — it's a DB-generated column. Either omit it from the model or map it read-only (`{ type: DataTypes.STRING, allowNull: true }` with no writes). `amount`/`commissionAmount`/`doctorPayoutAmount` are `DECIMAL` → coerce to `Number` in the serializer (Sequelize returns DECIMAL as a string). `slotStartTime`/`slotEndTime` are `TIME` → `"HH:mm"` strings. `slotDate` is `DATE` → `"YYYY-MM-DD"`.

**🟡 `models/index.js` — associations** (`doctorId` points at `DoctorProfile` PK `userId`; `patientId` at `User`):

```js
// Booking ↔ patient (User), doctor (DoctorProfile), clinic (nullable)
User.hasMany(Booking, { foreignKey: "patientId", as: "bookings" });
Booking.belongsTo(User, { foreignKey: "patientId", as: "patient" });
DoctorProfile.hasMany(Booking, { foreignKey: "doctorId", as: "bookings" });
Booking.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });
Booking.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// Payment 1:1 Booking
Booking.hasOne(Payment, { foreignKey: "bookingId", as: "payment", onDelete: "CASCADE" });
Payment.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
```

Export both new models from `models/index.js`.

---

## 3. Patient profile (Phase 0 — the gate)

### 3.1 `services/patient.service.js` 🔵

The `patient_profiles` row already exists from signup (`user.service.createProfileRow`). This service reads/updates it and computes completeness.

```js
getProfile(userId)               // User.findByPk(userId, include: patientProfile). One query.
updateProfile(userId, patch)     // whitelist demographic fields; upsert patient_profiles; also users.name/phone via a tx.
computeProfileStatus(user)       // -> { complete: boolean, missing: string[] } from PATIENT_REQUIRED_FIELDS.
assertProfileComplete(userId)    // throws 409 PROFILE_INCOMPLETE (details.missing) — called by booking.create.
```

> `updateProfile` mirrors `auth.service.updateProfile`'s tx pattern (shared user fields + role profile row updated atomically). Reuse it rather than duplicating — the `/patient/profile` controller can delegate to a thin patient-scoped wrapper.

### 3.2 Required fields + constants 🟡 `config/constants.js`

```js
const PATIENT_REQUIRED_FIELDS = Object.freeze(["phone", "dateOfBirth", "gender", "city"]);
// (users.name is already required at signup, so it's implicitly present)
const ERROR_CODES = { ...existing,
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  SLOT_TAKEN: "SLOT_TAKEN",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  PAYMENT_VERIFICATION_FAILED: "PAYMENT_VERIFICATION_FAILED",
  BOOKING_NOT_PAYABLE: "BOOKING_NOT_PAYABLE",
};
const BOOKING_HOLD_MINUTES = 10;
const PLATFORM_COMMISSION_PCT = 0.15; // README §4 open Q4
const BOOKING_STATUS = Object.freeze({ PENDING: "pending_payment", CONFIRMED: "confirmed", COMPLETED: "completed", CANCELLED: "cancelled", NO_SHOW: "no_show" });
const PAYMENT_STATUS = Object.freeze({ INITIATED: "initiated", SUCCESS: "success", FAILED: "failed", REFUNDED: "refunded", PENDING_AT_CLINIC: "pending_at_clinic" });
const BOOKING_MODES = Object.freeze({ VIDEO: "video", CLINIC: "clinic" }); // frontend vocabulary
```

### 3.3 Validators, controller, routes 🔵

- `validators/patient.validator.js`: `updateProfile` (Joi — `dateOfBirth` ISO past date, `gender` from `GENDERS`, phone/pincode patterns, all `.allow("", null)` except when required is enforced by the completeness engine, not Joi — Joi validates *shape*, the gate validates *presence*).
- `controllers/patient.controller.js`: thin — `getProfile`, `updateProfile` (return profile + `status`).
- `routes/patient.routes.js` 🔵: `const guard = [authenticate, authorize(ROLES.PATIENT)];` and mount in `routes/index.js` 🟡 with `router.use("/patient", require("./patient.routes"))`.

---

## 4. Free-slot computation 🟡

Extend the existing **read-only** `availability.service.previewSlots` (which today returns offered slots and explicitly does *not* subtract bookings) to subtract taken/held slots. Keep the **same response shape** (`{ doctorId, mode, clinicId, date, slots: string[] }`) so `frontend-patient` needs zero changes to consume it.

```js
// availability.service.previewSlots(rawQuery)  🟡  — after expanding `windows` into offered `slots`:
const taken = await bookingService.takenStartTimes(doctorId, dateStr); // Set<"HH:mm">, ACROSS all modes
return { ...unchanged, slots: offered.filter((t) => !taken.has(t)) };
```

`booking.service.takenStartTimes(doctorId, dateStr)` 🔵 — **one query, no loop**:

```js
// First, lazily expire stale holds so abandoned checkouts free their slot (§6.4).
await expireStaleHolds(doctorId, dateStr);
const rows = await Booking.findAll({
  where: { doctorId, slotDate: dateStr, status: { [Op.in]: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] } },
  attributes: ["slotStartTime"],
});
return new Set(rows.map((r) => r.slotStartTime.slice(0, 5)));
```

> **Cross-mode subtraction is deliberate** (PRD §4.3a): a doctor booked online at 10:00 must not be bookable at a clinic at 10:00. Since `taken` keys on `doctorId + slotStartTime` regardless of `clinic_id`, video and clinic slots contend for the same physical time — exactly what the `active_lock_key` enforces on write. The read path mirrors the write guard so the UI rarely shows a slot that will then 409.

---

## 5. `booking.service.js` 🔵 (the core)

All business logic + DB access; multi-row writes in `sequelize.transaction`; no queries in loops. Ownership is always a WHERE clause, never a post-load `if`.

### 5.1 `create(patientId, { doctorId, mode, clinicId, date, startTime, paymentMode })`

```
1. assertProfileComplete(patientId)                       → 409 PROFILE_INCOMPLETE (details.missing)
2. Load doctor profile (approved) + the fee source:
     mode=video  → online_fee (must be non-null; else 422 SLOT_UNAVAILABLE "no video consults")
     mode=clinic → clinic (findOne {id:clinicId, doctorId, isActive}) → offline_fee; 404 if not owned/active
3. Normalise payment mode:
     video  → force 'online'   (mandatory, PRD §4.6)
     clinic → 'online' | 'offline' (patient's choice)
4. Re-validate the slot is REAL & FREE (never trust the client):
     - reuse previewSlots(doctor, mode, clinicId, date) → startTime must be in that free list
     - date+startTime must be in the future (server clock)  → else 422 SLOT_UNAVAILABLE
     - compute slotEndTime = startTime + slotDurationMinutes (from the matched window)
5. bookingType = mode==='video' ? 'online' : 'offline'; clinicId = mode==='video' ? null : clinicId
6. INSERT booking:
     status = paymentMode==='offline' ? 'confirmed' : 'pending_payment'
     amount = server-computed fee
     — inside a tx; catch the unique-constraint error on uq_booking_doctor_slot_lock → 409 SLOT_TAKEN
7. Create the payment row (1:1):
     offline → { mode:'offline', status:'pending_at_clinic', amount }
     online  → payment.service.createOrder(booking)  → { mode:'online', status:'initiated', razorpayOrderId }
8. Side effects:
     offline (confirmed now)  → sendBookingConfirmation (mail.service) + email_notifications row
     online (pending)         → NO confirmation yet (wait for verify/webhook)
9. Return:
     offline → { booking, payment }
     online  → { booking, payment, razorpayOrder: { orderId, amount, currency:'INR', keyId } }  // keyId = public RAZORPAY_KEY_ID
```

The unique-constraint catch is the **only** correct double-booking guard — do not "check then insert" (that's a TOCTOU race). Insert, and let the DB reject the loser (`err.name === 'SequelizeUniqueConstraintError'` → `ApiError` 409 `SLOT_TAKEN`).

### 5.2 Reads

```js
listForPatient(patientId, { status })    // Booking.findAll where patientId, include doctor+clinic summary, order slotDate desc.
getForPatient(patientId, id)             // findOne {id, patientId} include payment; else 404.
listForDoctor(doctorId, { status, date, clinicId })  // where doctorId (=user.id), include patient summary.
getForDoctorWithPatientSnapshot(doctorId, id)        // {id, doctorId}; if status ∈ {confirmed,completed} include the FULL
                                         // patient snapshot (patient_profiles + allergies + conditions + current meds +
                                         // uploaded_records) via `include`; else return booking without the snapshot.
```

> The doctor snapshot is the payoff of forcing profile completion: `serializePatientSnapshot` (§7) shapes exactly the fields a doctor needs to "review the case." Gate it to confirmed/completed so a doctor can't scrape patient data off an unpaid pending hold.

### 5.3 Doctor actions

```js
markPaid(doctorId, id)     // offline only: payment pending_at_clinic → success, paid_at=now. 409 if not offline/not owned.
complete(doctorId, id, { noShow })  // confirmed → completed | no_show. Ownership-checked.
```

### 5.4 Cancel + stale-hold sweep

```js
cancel(patientId, id, reason)   // status → cancelled (frees the lock key), cancelledReason=reason.
                                // If online-paid within the window → mark refund (Phase 2: call Razorpay refund).
expireStaleHolds(doctorId, dateStr)  // UPDATE bookings SET status='cancelled', cancelled_reason='hold_expired'
                                     // WHERE status='pending_payment' AND created_at < now()-BOOKING_HOLD_MINUTES
                                     // (scoped to doctor+date; one UPDATE, no loop). Called by takenStartTimes + create.
```

---

## 6. `payment.service.js` 🔵 (Razorpay)

Wraps the `razorpay` SDK. **The key secret and webhook secret never leave the backend.** Idempotency is enforced by checking `payment.status` before every mutation.

### 6.1 `createOrder(booking)`
```js
const order = await razorpay.orders.create({ amount: Math.round(booking.amount * 100), currency: "INR",
  receipt: `booking_${booking.id}`, notes: { bookingId: String(booking.id) } });
// store razorpayOrderId on the payment row (status stays 'initiated')
return order;
```

### 6.2 `verify(patientId, bookingId, { razorpayOrderId, razorpayPaymentId, razorpaySignature })` — fast path
```
1. Load booking {id:bookingId, patientId} + payment; 404 if not owned.
2. If payment.status === 'success' → return already-confirmed (idempotent no-op).
3. If booking.status !== 'pending_payment' → 409 BOOKING_NOT_PAYABLE.
4. Verify HMAC:  expected = HMAC_SHA256(`${razorpayOrderId}|${razorpayPaymentId}`, RAZORPAY_KEY_SECRET)
   timing-safe-equal vs razorpaySignature; mismatch → 400 PAYMENT_VERIFICATION_FAILED.
5. confirmPaid(booking, payment, { razorpayPaymentId, razorpaySignature })  ← shared with webhook.
```

### 6.3 `handleWebhook(rawBody, signatureHeader)` — reliable backstop
```
1. Verify HMAC_SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET) === signatureHeader (timing-safe); else 400 (do NOT throw 500 — Razorpay retries).
2. Parse event: on 'payment.captured' / 'order.paid', extract order id → find payment by razorpayOrderId.
3. If payment.status === 'success' → 200 OK (idempotent; Razorpay retries land here harmlessly).
4. Else confirmPaid(...) with the webhook's payment id.
5. Always 200 on a handled event so Razorpay stops retrying.
```

### 6.4 `confirmPaid(booking, payment, { razorpayPaymentId, razorpaySignature })` — the one writer
```js
await sequelize.transaction(async (tx) => {
  payment.status = PAYMENT_STATUS.SUCCESS;
  payment.razorpayPaymentId = razorpayPaymentId;
  payment.razorpaySignature = razorpaySignature ?? payment.razorpaySignature;
  payment.paidAt = new Date();
  payment.commissionAmount = round2(payment.amount * PLATFORM_COMMISSION_PCT);
  payment.doctorPayoutAmount = round2(payment.amount - payment.commissionAmount);
  await payment.save({ transaction: tx });
  booking.status = BOOKING_STATUS.CONFIRMED;
  await booking.save({ transaction: tx });
});
// hook: video → generateMeetLink(booking) (DEFERRED to the video plan; leave null)
await mailService.sendBookingConfirmation(booking); // + payment receipt; log to email_notifications
```

Both the fast path and the webhook funnel through `confirmPaid`, and it early-returns if already `success`, so a payment can be confirmed **at most once** no matter which arrives first or how many times Razorpay retries (PRD §8).

### 6.5 Webhook route wiring (raw body!)
The signature is computed over the **raw** request body, so this route must bypass the global `express.json()` and use `express.raw({ type: 'application/json' })` on `/webhooks/razorpay` **before** JSON parsing. Mount it in `app.js` 🟡 (or a dedicated `routes/webhook.routes.js` 🔵 with its own raw parser), and exclude it from any CSRF/auth middleware.

---

## 7. Serializers — `utils/serializers.js` 🟡

```js
serializeBookingForPatient(b)   // { id, doctor:{name,slug,specialtyName,photoUrl}, clinic:{name,address}|null,
                                //   mode:(bookingType==='online'?'video':'clinic'), date, startTime, endTime,
                                //   status, amount:Number, paymentMode, meetLink,
                                //   payment:{ status } } — maps DB vocabulary → frontend `mode`.
serializeBookingForDoctor(b)    // list row: patient:{name}, mode, date, startTime, status, amount, paymentMode.
serializePatientSnapshot(user)  // { name, phone, dateOfBirth, age(derived), gender, bloodGroup, city, state,
                                //   allergies:[{name,severity}], conditions:[{name,diagnosedYear}],
                                //   currentMedications:[...], uploadedRecords:[{fileUrl,tag,recordDate}] }
serializePatientProfile(user)   // own profile + { status:{ complete, missing } }
serializeRazorpayOrder(order)   // { orderId, amount, currency, keyId: env.RAZORPAY_KEY_ID }  ← public key only
```

> Amount coercion (`Number`) and mode translation live **only** here so controllers stay dumb and the DB↔frontend vocabulary map exists in exactly one place.

---

## 8. Config, env, deps, swagger

- **`config/env.js`** 🟡: add + validate `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (fail fast at boot if missing in production, like the existing secrets). `RAZORPAY_KEY_ID` is the only one ever sent to the client.
- **`config/constants.js`** 🟡: the §3.2 additions.
- **Dependencies:** `npm i razorpay` (official Node SDK). HMAC uses the built-in `crypto` — no extra dep. No new dep for emails (existing `nodemailer` via `mail.service`).
- **`config/swagger.js`** 🟡: a `Bookings & Payments` tag documenting every §5 route, the `Booking`/`Payment`/`RazorpayOrder`/`PatientSnapshot` schemas, and the error codes (`PROFILE_INCOMPLETE`, `SLOT_TAKEN`, `SLOT_UNAVAILABLE`, `PAYMENT_VERIFICATION_FAILED`, `BOOKING_NOT_PAYABLE`).
- **`templates/emails/`** 🔵: `booking-confirmation.html`, `payment-receipt.html` (mirror the existing `verify-email.html` shape); `mail.service` 🟡 gains `sendBookingConfirmation(booking)`.

---

## 9. Controllers & routes 🔵

Controllers stay thin (validated input + `req.user.id` + `req.params.id` → one service call → `ok()/created()`, wrapped in `asyncHandler`, no `Model.` calls).

- `controllers/booking.controller.js` (patient side) + `controllers/doctorBooking.controller.js` (doctor side) + `controllers/paymentWebhook.controller.js`.
- `routes/patient.routes.js` 🔵 — §5.1 routes, all `authenticate + authorize(ROLES.PATIENT)`, mounted `/patient`.
- Doctor booking routes fold into `routes/doctor.routes.js` 🟡 (or a small `doctorBooking.routes.js` also mounted under `/doctor`), all `authorize(ROLES.DOCTOR)`.
- `routes/webhook.routes.js` 🔵 — public, raw-body, mounted `/webhooks` (see §6.5 for the body-parser ordering).
- `validators/booking.validator.js` 🔵: `createBooking` (`mode∈{video,clinic}`, `clinicId` required when `mode=clinic`, `date` ISO, `startTime` `HH:mm`, `paymentMode∈{online,offline}`), `verifyPayment` (three razorpay strings required), `cancel`, `markComplete`.

---

## 10. Build order (backend)

1. 🔵 `patient.service` + validator + controller + `/patient/profile` routes + `PATIENT_REQUIRED_FIELDS`/`computeProfileStatus`. Smoke-test the gate: `GET /patient/profile` shows `status.complete=false` on a fresh patient.
2. 🔵 `005_bookings_payments.sql` → `npm run migrate`; `Booking`/`Payment` models + associations in `index.js`.
3. 🟡 `takenStartTimes` + `expireStaleHolds`; wire into `previewSlots` → `/doctors/:id/slots` now returns free slots.
4. 🔵 `booking.service.create` **offline branch** (immediate confirm) + patient/doctor reads + `mark-paid`/`complete` + serializers. Test the lock-key 409 with two concurrent creates.
5. 🔵 `payment.service` (`createOrder`, `verify`, `confirmPaid`) + online branch of `create`; env + `razorpay` dep.
6. 🔵 webhook route (raw body) + `handleWebhook`; test idempotency (verify then webhook = one confirm).
7. 🟡 confirmation/receipt emails + swagger entries as each route lands.

---

## 11. Testing checklist (backend)

- [ ] Migration idempotent (run twice); `bookings` has the generated `active_lock_key` + `uq_booking_doctor_slot_lock`; `payments` has `uq_payment_booking`.
- [ ] `GET /patient/profile` on a fresh patient → `status.complete=false`, `missing=["phone","dateOfBirth","gender","city"]`; after `PUT` with all four → `complete=true`.
- [ ] `POST /patient/bookings` with an incomplete profile → `409 PROFILE_INCOMPLETE` (`details.missing`).
- [ ] Client-sent `amount` is ignored — booking `amount` always equals the server fee (video→online_fee, clinic→that clinic's offline_fee).
- [ ] `mode=video` forces `payment_mode=online`; a doctor with `online_fee=null` → `422 SLOT_UNAVAILABLE`.
- [ ] Two concurrent `POST /patient/bookings` for the same `doctorId+date+startTime` → exactly one `pending_payment`, the other `409 SLOT_TAKEN`.
- [ ] A booked slot disappears from `GET /doctors/:id/slots` for **both** the same mode and the other mode (cross-mode contention).
- [ ] Offline clinic booking → `confirmed` immediately, payment `pending_at_clinic`; confirmation email sent + `email_notifications` row.
- [ ] Online booking → `pending_payment` + a Razorpay order returned with the **public** key only; the secret never appears in any response.
- [ ] `POST /pay/verify` with a tampered signature → `400 PAYMENT_VERIFICATION_FAILED`, booking stays `pending_payment`.
- [ ] `verify` then the webhook for the same order → payment `success` written **once**; the second call is a 200/no-op (idempotent). Webhook with a bad body signature → 400, no state change.
- [ ] `pending_payment` older than `BOOKING_HOLD_MINUTES` is swept to `cancelled` and its slot reappears in `/slots`.
- [ ] `GET /doctor/bookings/:id` on a `confirmed` booking returns the patient snapshot; on a `pending_payment` booking it omits the snapshot; another doctor's token → 404 (no leak).
- [ ] `mark-paid` flips an offline payment to `success`; `complete`/`no_show` transitions are ownership-checked.
- [ ] `commission_amount` + `doctor_payout_amount` are stored on every successful online payment and sum to `amount`.
- [ ] Every `/patient/*` route 403s for a doctor/admin token and vice-versa; `/webhooks/razorpay` needs no app token but rejects an unsigned body.
