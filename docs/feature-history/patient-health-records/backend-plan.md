# Backend Plan — Patient Health Records

Builds the reserved patient sub-resources (§2 of `dbstruct.md`) plus the new **`patient_vitals`** timeline, the read-gate that lets a treating doctor see them, and a **completion-percentage** engine for the dashboard bar. **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

All routes keep the existing conventions (see the `backend-conventions` skill): thin controllers, Joi-only validation declared on the route, services own the DB work, serializers own the response shape, the `ok()`/`created()` envelope.

---

## 1. Migration `010_patient_health.sql` 🔵

Follows the exact shapes already designed in `docs/dbstruct.md` (so this migration is "catch the code up to the schema"), plus one new table.

### 1.1 Extend `patient_profiles` 🟡
Add the columns the schema defines but the model never mapped:

```sql
ALTER TABLE patient_profiles
  ADD COLUMN emergency_contact_name  VARCHAR(150) NULL,
  ADD COLUMN emergency_contact_phone VARCHAR(20)  NULL;
-- height_cm / weight_kg / bmi already exist in dbstruct.md; if absent in the live
-- DB, add them here. They become DERIVED "latest" values (see README D3).
```
A **boot shim** (`db/ensurePatientProfileColumns.js`, mirroring `ensureClinicalNoteVitals`) idempotently adds any missing column at dev boot, since `sequelize.sync()` never ALTERs.

### 1.2 Lookup + junction tables (M:N) 🔵
`allergies (id, name)` + `patient_allergies (patient_id, allergy_id, severity ENUM('mild','moderate','severe'))`; `conditions (id, name)` + `patient_conditions (patient_id, condition_id, diagnosed_year SMALLINT)`. Both junctions FK `patient_profiles(user_id) ON DELETE CASCADE`. Seed the `allergies`/`conditions` lookups from the `INSERT` lists already at the bottom of `dbstruct.md`.

### 1.3 `patient_current_medications` (1:M) 🔵
`id, patient_id, medicine_name, dosage, frequency, started_on DATE, notes` — verbatim from `dbstruct.md §2c`.

### 1.4 `uploaded_records` (1:M) 🔵
`id, patient_id, file_url, file_type ENUM('prescription','lab_report','other'), record_date DATE, tag, uploaded_at` — verbatim from `dbstruct.md §16`.

### 1.5 `patient_vitals` (1:M) 🔵 — **the record-table rows (NEW)**

```sql
CREATE TABLE patient_vitals (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id     BIGINT UNSIGNED NOT NULL,
  recorded_on    DATE NOT NULL,                         -- the matrix column key
  blood_pressure VARCHAR(20)         NULL,              -- free text "120/80"
  pulse_rate_bpm SMALLINT UNSIGNED   NULL,
  weight_kg      DECIMAL(5,2)        NULL,
  height_cm      DECIMAL(5,2)        NULL,
  temperature_f  DECIMAL(4,1)        NULL,
  spo2_percent   TINYINT UNSIGNED    NULL,
  note           VARCHAR(255)        NULL,
  source         ENUM('patient','doctor') NOT NULL DEFAULT 'patient',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_patvit_patient FOREIGN KEY (patient_id)
    REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
  KEY idx_patvit_patient_date (patient_id, recorded_on)
) ENGINE=InnoDB;
```

- **Types deliberately match `clinical_notes` vitals** (see `frontend-doctor/docs/feature-history/clinical-notes/vitals-and-prescription.md §1`) so the two sources are interchangeable and a future unified timeline (README §8.1) is trivial.
- **BMI is not stored** — derived in the serializer from `weight_kg` + `height_cm` (single source of truth).
- Multiple rows per day are allowed (no unique on `recorded_on`); the matrix groups by the exact `recorded_on`, newest-first.

---

## 2. Models 🔵🟡

| Model | Notes |
|---|---|
| `patientProfile.model.js` 🟡 | Add `emergencyContactName`, `emergencyContactPhone` (+ optional `heightCm`/`weightKg`/`bmi` if kept). `underscored: true` maps camel→snake. |
| `allergy.model.js` / `condition.model.js` 🔵 | `{ id, name }`, `timestamps:false`. |
| `patientCurrentMedication.model.js` 🔵 | `{ id, patientId, medicineName, dosage, frequency, startedOn, notes }`. |
| `uploadedRecord.model.js` 🔵 | `{ id, patientId, fileUrl, fileType, recordDate, tag, uploadedAt }`. |
| `patientVitals.model.js` 🔵 | The table in §1.5; DECIMALs are read back as strings by mysql2 — the serializer coerces to `Number` (same gotcha as clinical-note vitals). |

### 2.1 `models/index.js` 🟡 — associations
```js
PatientProfile.belongsToMany(Allergy,  { through: PatientAllergy,  foreignKey: "patientId", as: "allergies" });
PatientProfile.belongsToMany(Condition,{ through: PatientCondition, foreignKey: "patientId", as: "conditions" });
PatientProfile.hasMany(PatientCurrentMedication, { foreignKey: "patientId", as: "medications" });
User.hasMany(UploadedRecord,  { foreignKey: "patientId", as: "uploadedRecords" });
PatientProfile.hasMany(PatientVitals, { foreignKey: "patientId", as: "vitals" });
```
(Junctions `patient_allergies`/`patient_conditions` carry the extra `severity`/`diagnosedYear` columns — expose them via `through` attributes.)

---

## 3. Validators — `validators/patient.validator.js` 🟡

Keep the existing `updateProfile` (extend with `emergencyContactName`, `emergencyContactPhone`). Add:

- `setAllergies` — `{ items: [{ name, severity? }] }` (replace-set semantics) **or** `addAllergy`/`removeAllergy` — pick one style; recommend **replace-set** per resource for simpler forms.
- `setConditions` — `{ items: [{ name, diagnosedYear? }] }`.
- `upsertMedication` — `{ medicineName (req), dosage?, frequency?, startedOn?, notes? }`.
- `addRecord` — `{ fileUrl (req uri), fileType, recordDate?, tag? }`.
- **`addVitalsEntry`** — `{ recordedOn (date, ≤ today, default today), bloodPressure?, pulseRateBpm?, weightKg?, heightCm?, temperatureF?, spo2Percent?, note? }` with the **same numeric ranges** as the clinical-note vitals validator, and a **"≥1 vital present"** rule (an all-empty column is meaningless — mirrors the notes' "≥1 detail" rule).

---

## 4. Services

### 4.1 `services/patient.service.js` 🟡
- Extend `updateProfile` whitelist with the emergency-contact fields.
- **List reads** for each sub-resource (`getAllergies`, `getConditions`, `getMedications`, `getRecords`) — each a single scoped query (no N+1; see `backend-conventions`).
- **Write ops** — replace-set for allergies/conditions (find-or-create the lookup row by name inside a transaction, then reset the junction); create/update/delete for medications and records.
- **`computeProfileCompletion(user)`** 🔵 — supersedes the boolean `computeProfileStatus` for the dashboard bar. Returns:
  ```
  { percent, sections: [{ key, label, done, weight }], missingRequired: string[] }
  ```
  Weighted sections (tune the weights):
  | Section | Done when | Weight |
  |---|---|---|
  | Identity (phone, dob, gender, city) | all present *(the existing required set)* | 40 |
  | Address (addressLine, state, pincode) | all present | 10 |
  | Emergency contact | name + phone present | 10 |
  | Blood group | set & ≠ `unknown` | 10 |
  | Allergies **or** "none" ack | ≥1 recorded or explicitly marked none | 10 |
  | Conditions **or** "none" ack | ≥1 recorded or explicitly marked none | 10 |
  | Vitals | ≥1 `patient_vitals` row | 10 |
  `percent = round(Σ done·weight)`. Keep `computeProfileStatus` (the booking gate) unchanged — completion % is additive and never blocks booking.

### 4.2 `services/patientVitals.service.js` 🔵
- `listForPatient(patientId)` → all rows, `recorded_on` DESC then `created_at` DESC.
- `addForPatient(patientId, body)` → insert one row (`source='patient'`).
- `listForBookingPatient(bookingId, doctorId)` → the **doctor read-gate**: reuse the exact pattern from `clinicalNote.service.listForBookingPatient` — the booking must be the **doctor's own** and status ∈ `{confirmed, completed}`; then resolve `booking.patientId` and return that patient's vitals. Consistent with how clinical notes + the snapshot already gate.

---

## 5. Controllers & routes

### 5.1 `controllers/patient.controller.js` 🟡 (thin)
One handler per read/write above; each calls one service fn, attaches `computeProfileCompletion` where the profile is returned, serializes, `ok()/created()`.

### 5.2 `routes/patient.routes.js` 🟡
```
GET/PUT   /patient/profile                    (🟡 extended fields + completion in payload)
GET/PUT   /patient/allergies                  (replace-set)
GET/PUT   /patient/conditions                 (replace-set)
GET/POST  /patient/medications                · PATCH/DELETE /patient/medications/:id
GET/POST  /patient/records                    · DELETE /patient/records/:id
GET/POST  /patient/vitals                     (🔵 list / add a matrix column)
```
All under the existing `guard = [authenticate, authorize(PATIENT)]`; `validate(schema.x)` on writes.

### 5.3 `routes/doctorBooking.routes.js` 🟡 + `controllers/doctorBooking.controller.js` 🟡
```
GET /doctor/bookings/:id/patient-vitals   → doctor + owns booking + confirmed/completed
```
Mirrors the existing `GET /doctor/bookings/:id/clinical-notes` wiring exactly.

---

## 6. Serializers — `utils/serializers.js` 🟡

- **`serializePatientSnapshot`** 🟡 — replace the four hardcoded `[]` with the **real** joined data:
  `allergies` → `{ name, severity }[]`, `conditions` → `{ name, diagnosedYear }[]`, `currentMedications` → `{ medicineName, dosage, frequency }[]`, `uploadedRecords` → `{ fileUrl, tag, recordDate, fileType }[]`. Shapes already match the doctor's `PatientSnapshot` TS type — **no frontend type change needed** for these four.
- **`serializePatientVitals(rows)`** 🔵 — returns the **matrix contract**:
  ```json
  {
    "fields": [
      { "key": "bloodPressure", "label": "BP", "unit": "mmHg" },
      { "key": "pulseRateBpm",  "label": "Pulse", "unit": "bpm" },
      { "key": "weightKg",      "label": "Weight", "unit": "kg" },
      { "key": "heightCm",      "label": "Height", "unit": "cm" },
      { "key": "temperatureF",  "label": "Temp", "unit": "°F" },
      { "key": "spo2Percent",   "label": "SpO₂", "unit": "%" },
      { "key": "bmi",           "label": "BMI", "unit": "", "derived": true }
    ],
    "entries": [
      { "id": "…", "recordedOn": "2026-07-14", "source": "patient", "note": null,
        "values": { "bloodPressure": "120/80", "pulseRateBpm": 72, "weightKg": 72.5,
                    "heightCm": 176, "temperatureF": 98.4, "spo2Percent": 98, "bmi": 23.4 } }
    ]
  }
  ```
  DECIMALs coerced to `Number`; `bmi = round(weightKg / (heightCm/100)^2, 1)` when both present, else `null`. `entries` newest-first. The frontend renders `fields` as rows and `entries` as columns directly.
- **`serializeProfileCompletion(completion)`** 🔵 — passes through `{ percent, sections, missingRequired }`.
- `serializePatientProfile` 🟡 — include the new fields + embed `completion`.

---

## 7. Verification (backend)

- `npm run migrate` applies only `010`; tables + seeds present; `patient_profiles` gains the columns.
- Models `require` clean; associations resolve; `PatientVitals` etc. registered.
- Round-trips (curl / REST client): add allergy/condition/med/record/vitals → read back; `POST /patient/vitals` all-empty → `422`; completion `percent` moves as sections fill.
- Doctor gate: `GET /doctor/bookings/:id/patient-vitals` on a **non-owned** or **pending** booking → `404/403`; on a confirmed own booking → the matrix.
- Snapshot: `GET /doctor/bookings/:id` now returns the real lists (not `[]`).
</content>
</invoke>
