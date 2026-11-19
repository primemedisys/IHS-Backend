# Follow-up status — backend plan

🔵 Planned. Follows `backend/` conventions: routes → validators (Joi only) → controllers (thin) →
services (all logic) → serializers. See the `backend-conventions` skill.

---

## 1. Tables

### 1.1 🔵 `follow_up_statuses` — the doctor's own option list

```sql
CREATE TABLE follow_up_statuses (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id  BIGINT UNSIGNED NOT NULL,
  label      VARCHAR(40)  NOT NULL,          -- "OPD FU"
  color_hex  CHAR(7)      NOT NULL,          -- "#2E86C1"
  sort_order SMALLINT     NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,-- archive instead of delete when in use
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fus_doctor_label (doctor_id, label),
  CONSTRAINT fk_fus_doctor FOREIGN KEY (doctor_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **`UNIQUE (doctor_id, label)`** — two statuses called "OPD FU" on one doctor's list is a data-entry
  slip, not a use case, and the filter dropdown would show the same word twice.
- **`is_active`, not a hard delete** — a status in use is archived. Hard-deleting it would orphan
  every assignment pointing at it (see §3.4).
- **`sort_order`** — the doctor's own order in the dropdown; a surgeon wants `SX WAITING` near the
  top, an internist never uses it.

### 1.2 🔵 `patient_follow_ups` — the assignment

```sql
CREATE TABLE patient_follow_ups (
  doctor_id     BIGINT UNSIGNED NOT NULL,
  patient_id    BIGINT UNSIGNED NOT NULL,
  status_id     BIGINT UNSIGNED NOT NULL,
  follow_up_on  DATE         NULL,           -- the date the patient is expected back
  note          VARCHAR(140) NULL,
  booking_id    BIGINT UNSIGNED NULL,        -- the consult it was set from, for provenance
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (doctor_id, patient_id),
  KEY idx_pfu_status (status_id),
  KEY idx_pfu_due (doctor_id, follow_up_on),
  CONSTRAINT fk_pfu_doctor  FOREIGN KEY (doctor_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pfu_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pfu_status  FOREIGN KEY (status_id)  REFERENCES follow_up_statuses (id),
  CONSTRAINT fk_pfu_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **PK `(doctor_id, patient_id)`** — one current status per pair, exactly like the table it replaces.
  Setting a status is an upsert, so the composer can be saved twice with no duplicate rows.
- **`fk_pfu_status` has NO `ON DELETE CASCADE`** — deliberately. It is what makes "you can't delete a
  status that is in use" a database guarantee rather than a service-layer promise.
- **`follow_up_on` is nullable** — `SX WAITING` with no date yet is a real state; forcing a date
  would make doctors invent one.

### 1.3 🟡 Migration `025_follow_up_statuses.sql`

Idempotent and information_schema-guarded, like 013–024. Three steps:

1. Create both tables.
2. **Seed** the four sketch statuses for every doctor who already has a row in
   `doctor_patient_statuses`, plus every doctor with at least one booking.

   These are a **starting list, not a fixed set** — ordinary rows the doctor may rename, recolour,
   reorder, extend or delete outright. No code path may ever compare against these labels; anything
   that branches on the text `"OPD FU"` breaks the moment a doctor renames it to `"Review"`.

   | label | color_hex | sort |
   |---|---|---|
   | `NEW PATIENT` | `#2E7D53` (green) | 0 |
   | `OPD FU` | `#2E86C1` (blue) | 1 |
   | `SX WAITING` | `#B07714` (amber) | 2 |
   | `SX FU` | `#5B4CB0` (violet) | 3 |

3. **Backfill** `patient_follow_ups` from `doctor_patient_statuses`, mapping
   `new_patient → NEW PATIENT`, `opd_followup → OPD FU`, `surgery_pending → SX WAITING`,
   `surgery_followup → SX FU`, with `follow_up_on = NULL`.

`doctor_patient_statuses` is **left in place, unread**, for one release. Dropping a table in the same
migration that replaces it leaves no way back if the backfill is wrong.

> New doctors get the four seed rows lazily, on first read of `GET /doctor/follow-up-statuses` —
> the same pattern as `ensureDoctorPatientStatus.js`. A doctor who signs up after this migration
> must not get an empty list.

---

## 2. Models

🔵 `models/followUpStatus.model.js`, 🔵 `models/patientFollowUp.model.js`, registered in
`models/index.js` with:

```js
FollowUpStatus.hasMany(PatientFollowUp, { as: "assignments", foreignKey: "statusId" });
PatientFollowUp.belongsTo(FollowUpStatus, { as: "status", foreignKey: "statusId" });
PatientFollowUp.belongsTo(User, { as: "patient", foreignKey: "patientId" });
```

---

## 3. Endpoints

All under `/doctor`, all behind the existing doctor auth middleware. Ownership is always a `WHERE
doctor_id = req.doctorId`, never a post-load check.

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | `GET` | `/doctor/follow-up-statuses` | The doctor's list (seeds on first call) |
| 2 | `POST` | `/doctor/follow-up-statuses` | Add one |
| 3 | `PATCH` | `/doctor/follow-up-statuses/:id` | Rename / recolour / reorder / archive |
| 4 | `DELETE` | `/doctor/follow-up-statuses/:id` | Delete — **409 when in use** |
| 5 | `PUT` | `/doctor/patients/:patientId/follow-up` | Set/replace this patient's status + date |
| 6 | `DELETE` | `/doctor/patients/:patientId/follow-up` | Clear it |

### 3.1 Validators (Joi, `validators/followUp.validator.js`)

```js
label:     Joi.string().trim().min(2).max(40).required()
colorHex:  Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).required()
sortOrder: Joi.number().integer().min(0).max(999)
isActive:  Joi.boolean()
statusId:  Joi.string().required()          // ids cross the wire as strings
followUpOn: Joi.date().iso().allow(null)    // NOT .min('now') — a doctor may back-date
note:      Joi.string().trim().max(140).allow('', null)
```

### 3.2 Setting a status (#5) — one query, not a loop

```js
async function setFollowUp(doctorId, patientId, { statusId, followUpOn, note, bookingId }) {
  // The status must be the DOCTOR'S OWN — otherwise a doctor could tag their
  // patient with another doctor's private category by guessing an id.
  const status = await FollowUpStatus.findOne({ where: { id: statusId, doctorId } });
  if (!status) throw ApiError.notFound("Follow-up status not found");

  // The doctor must actually have seen this patient. Same gate the timeline uses.
  await assertDoctorHasPatient(doctorId, patientId);

  const [row] = await PatientFollowUp.upsert({ doctorId, patientId, statusId, followUpOn, note, bookingId });
  return row;
}
```

### 3.3 Reading with the roster — no N+1

The appointments list already loads bookings for a doctor. The follow-up joins as one more include,
keyed by patient:

```js
const doctorListView = [
  { model: User, as: "patient", attributes: ["id", "name", "profilePhotoUrl"] },
  // …clinic, payment, bookedBy as today…
];
// The follow-up is per PATIENT, not per booking, so it is fetched once for the
// whole page and stitched in memory rather than joined per row.
const followUps = await PatientFollowUp.findAll({
  where: { doctorId, patientId: { [Op.in]: patientIds } },
  include: [{ model: FollowUpStatus, as: "status" }],
});
```

Stitching in memory keeps one query for N bookings — a join per booking row would repeat the same
patient's status on every one of their appointments.

### 3.4 Deleting a status (#4)

```js
const inUse = await PatientFollowUp.count({ where: { statusId: id } });
if (inUse > 0) {
  throw new ApiError(409, `${inUse} patient(s) still use this status`, {
    code: ERROR_CODES.STATUS_IN_USE,
    details: { inUse },
  });
}
```

The frontend turns that 409 into "Archive instead?" — see `frontend-plan.md` §2.3.

---

## 4. Serializers

```js
function serializeFollowUpStatus(s) {
  return { id: String(s.id), label: s.label, colorHex: s.colorHex,
           sortOrder: s.sortOrder, isActive: Boolean(s.isActive), inUse: s.inUse ?? undefined };
}

/** What a roster row carries. Null when the doctor hasn't tagged this patient. */
function serializeFollowUp(f) {
  if (!f) return null;
  return {
    status: serializeFollowUpStatus(f.status),
    followUpOn: f.followUpOn,          // "YYYY-MM-DD" or null
    note: f.note ?? null,
    updatedAt: f.updatedAt,
  };
}
```

🟡 `serializeBookingForDoctor` gains `followUp: serializeFollowUp(x.patientFollowUp)` — additive, so
every existing consumer keeps working.

🟡 The patient summary the roster needs (**age, phone, address**) is not on the booking list today.
Add to the same serializer, from a `PatientProfile` include:

```js
patient: {
  id, name, photoUrl,
  age: ageFrom(profile.dateOfBirth),   // the helper serializers.js already has
  phone: patient.phone ?? null,
  city: profile.city ?? null,
  addressLine: profile.addressLine ?? null,
}
```

> This is patient PII on a list endpoint. It is already gated to the doctor's own bookings, and the
> doctor can see all of it on the record page — but it is worth naming, because the list is now a
> bigger payload and a wider exposure than it was.
