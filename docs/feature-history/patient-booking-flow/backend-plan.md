# Backend — Booking Engine (existing) + Doctor-Approval Workflow (proposed)

The patient booking flow **consumes an already-built backend** — this file documents that surface (so the frontend contract is unambiguous) and then specifies the **proposed doctor-approval workflow** (README §7), which is *not yet built* and is gated on the payment-scope decision. **Legend:** 🟢 exists · 🟡 extend · 🔵 new. Paths under `backend/src/`.

---

## 1. Schema 🟢 — `db/migrations/005_bookings_payments.sql`

- **`bookings`** — `patient_id`, `doctor_id`, `clinic_id?`, `booking_type` (`online|offline`), `slot_date`, `slot_start_time`, `slot_end_time`, `amount`, `status`, `payment_mode`, `cancelled_reason?`, timestamps.
- **Slot race safety** — a generated `active_lock_key` (doctor + date + start, only while the hold is live) is **UNIQUE**. Two patients on the same slot ⇒ the DB rejects the loser (`SequelizeUniqueConstraintError` → `409 SLOT_TAKEN`). Never "check then insert". (`db/ensureBookingLockKey.js`.)
- **`payments`** — `booking_id`, `amount`, `mode` (`online|offline`), `status`, `razorpay_order_id?`, `paid_at?`.

## 2. Status lifecycle 🟢 — `config/constants.js`

```
BOOKING_STATUS = { PENDING: 'pending_payment', CONFIRMED: 'confirmed',
                   COMPLETED: 'completed', CANCELLED: 'cancelled', NO_SHOW: 'no_show' }
PAYMENT_STATUS = { INITIATED, PENDING_AT_CLINIC, SUCCESS, FAILED, REFUNDED }
BOOKING_MODES  = { VIDEO: 'video', CLINIC: 'clinic' }   // availability vocabulary
```

**Today's flow (no approval):**

```
offline (pay at clinic):  create ─▶ CONFIRMED           (payment: pending_at_clinic)
online  (video / pay now): create ─▶ pending_payment ─▶ Razorpay verify ─▶ CONFIRMED
doctor actions:            CONFIRMED ─▶ COMPLETED | NO_SHOW ;  mark-paid: pending_at_clinic ─▶ SUCCESS
patient action:            pending_payment | CONFIRMED ─▶ CANCELLED  (frees the slot)
```

## 3. Service 🟢 — `services/booking.service.js`

- `create(patientId, {doctorId, mode, clinicId, date, startTime, paymentMode})` — asserts a complete patient profile, **recomputes the fee server-side** (`resolveFeeAndMode` — never trusts the client), re-validates the slot (`availabilityService.resolveBookableSlot`), inserts. Offline = `CONFIRMED` + `pending_at_clinic` (atomic tx); online = `pending_payment` hold → `paymentService.createOrder` → returns the Razorpay order.
- `verifyPayment(patientId, bookingId, body)` — verifies the signature → confirm.
- `listForPatient(patientId, {status?})` / `getForPatient` — patient reads (eager-load `patientView`).
- `listForDoctor(doctorId, {status?, date?, clinicId?})` — doctor list; filters map straight to `where` (`status`, `slotDate`, `clinicId`). **Verified working** against the live row.
- `getForDoctorWithPatientSnapshot(doctorId, id)` — snapshot exposed **only** for `CONFIRMED`/`COMPLETED` (a doctor can't read patient data off an unpaid hold).
- `markPaid` (offline `pending_at_clinic → success`), `complete` (`CONFIRMED → COMPLETED|NO_SHOW`), `cancel`.

## 4. Endpoints 🟢

| Method | Path | Guard | Controller |
|---|---|---|---|
| `POST` | `/patient/bookings` | patient | `booking.controller.create` |
| `POST` | `/patient/bookings/:id/pay/verify` | patient | `verify` |
| `GET` | `/patient/bookings` (`?status`) | patient | `list` |
| `GET`/`POST` | `/patient/bookings/:id` · `/:id/cancel` | patient | `getOne` · `cancel` |
| `GET` | `/doctor/bookings` (`?status&date&clinicId`) | doctor + `resolveDoctorId('self')` | `doctorBooking.controller.list` |
| `GET` | `/doctor/bookings/:id` | doctor | `getOne` (+ snapshot) |
| `POST` | `/doctor/bookings/:id/mark-paid` · `/complete` | doctor | `markPaid` · `complete` |

Mounted in `routes/index.js` (`/patient`, `/doctor`). Standard envelope `{ success, message, data }` / `{ error: { code, message } }`.

---

## 5. Proposed — Doctor-Approval Workflow 🔵🟡 (gated on README §7)

**Goal:** an offline booking is created **Pending** (not auto-confirmed); the doctor **Confirms** or **Rejects**; the result is visible to the patient.

### 5.1 Constants 🟡 — `config/constants.js`
Add `BOOKING_STATUS.PENDING_APPROVAL = 'pending_approval'` and `REJECTED = 'rejected'`.

### 5.2 `create` 🟡 — `booking.service.js`
Offline branch: insert `status: PENDING_APPROVAL` (was `CONFIRMED`); payment stays `pending_at_clinic`. **Online branch depends on the §7 decision:**
- *Pay-at-clinic-only scope (recommended):* leave online exactly as-is (`pending_payment → CONFIRMED`) — no approval, no refund.
- *Approve-before-pay:* create online as `PENDING_APPROVAL` with **no** Razorpay order; issue the order only after `confirm`.
- *Pay-upfront + refund-on-reject:* keep the order; `reject` triggers `paymentService.refund`.

### 5.3 Actions 🔵 — `booking.service.js`
```
confirm(doctorId, id): PENDING_APPROVAL ─▶ CONFIRMED   (else 409 BOOKING_NOT_PENDING)
reject (doctorId, id, {reason?}): PENDING_APPROVAL ─▶ REJECTED  + cancelled_reason
                                  (nulls the lock key ⇒ slot frees)
```
`getForDoctorWithPatientSnapshot`: keep the snapshot gated to `CONFIRMED`/`COMPLETED` (a pending request shows time/mode only, not patient data) — or extend to `PENDING_APPROVAL` if the doctor needs the reason to decide (product call).

### 5.4 Controller + routes 🔵
`doctorBooking.controller.{confirm,reject}` (thin) → `POST /doctor/bookings/:id/confirm`, `POST /doctor/bookings/:id/reject` (guard `authenticate + authorize('doctor') + resolveDoctorId('self')`; `reject` uses `validate(bookingSchema.rejectBooking)` for an optional `reason`).

### 5.5 Serializers + validator 🟡
`serializeBookingForDoctor`/`…ForPatient` already pass `status` through — the new values flow automatically. Add a Joi `rejectBooking` (`{ reason: string().max(300).allow('') }`). Swagger: document the two routes + the two new statuses.

### 5.6 Cancellation guard 🟡
`cancel` currently allows `pending_payment | confirmed`; decide whether a patient may also cancel a `PENDING_APPROVAL` request (recommended: yes — treat like a pending hold).

---

## 6. Build order (approval workflow, once §7 is decided)

1. Constants (2 statuses) → `create` offline → `PENDING_APPROVAL`.
2. `confirm`/`reject` service + controller + routes + `rejectBooking` validator.
3. `cancel` guard + snapshot gate decision; swagger.
4. Frontend status meta on both apps (patient `MyBookingsView`, doctor `AppointmentsBoard`) + doctor Confirm/Reject buttons + mutations (`useConfirmAppointment`/`useRejectAppointment`).
5. *(if online in scope)* payment re-sequencing / refund path.

## 7. Testing checklist (approval workflow)

- [ ] Offline booking is created `pending_approval`; patient sees **Pending**.
- [ ] Doctor **Confirm** → `confirmed` → patient sees **Confirmed**.
- [ ] Doctor **Reject** → `rejected` → patient sees **Rejected**; the slot is bookable again.
- [ ] `confirm`/`reject` on a non-pending booking → `409`.
- [ ] Online path behaves per the chosen §7 option (no refund leak).
