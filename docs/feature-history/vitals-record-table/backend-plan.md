# Backend Plan — Vitals Record Table (Location + column re-order)

Adds a nullable **`location`** to the `patient_vitals` timeline, surfaces it on the matrix payload,
and **re-orders** the matrix `fields` so the frontend renders columns in the requested order. BMI
stays derived (no storage change). **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

All routes keep the existing conventions (see the `backend-conventions` skill): thin controllers,
Joi-only validation on the route, services own the DB work, serializers own the response shape, the
`ok()`/`created()` envelope. **No route or handler changes** — every write already flows through the
existing `POST /patient/vitals` and `POST /doctor/bookings/:id/patient-vitals`.

---

## 1. Migration `012_vitals_location.sql` 🔵

Idempotent, `information_schema`-guarded column add (mirrors the guarded ALTERs in
`010_patient_health.sql`). No `USE <db>` — the runner already selects `env.DB_NAME`.

```sql
-- 012 — Vitals reading location (docs-shared/feature-plans/vitals-record-table/)
-- Adds patient_vitals.location: free-text place a reading was taken ("Home", "Apollo Clinic").
-- Idempotent (guarded) — safe to re-run.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'patient_vitals'
               AND column_name = 'location');
SET @s := IF(@c = 0,
  'ALTER TABLE patient_vitals ADD COLUMN location VARCHAR(150) NULL AFTER note',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
```

## 2. Dev boot shim `db/ensureVitalsLocation.js` 🔵 + `server.js` 🟡

`sequelize.sync()` never ALTERs an existing table, so a dev DB that already has `patient_vitals`
won't gain the column from the model alone. Add a shim mirroring `db/ensureReferralColumns.js`:

```js
const { QueryTypes } = require("sequelize");
const COLUMNS = [{ name: "location", ddl: "VARCHAR(150) NULL" }];

async function ensureVitalsLocation(sequelize) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'patient_vitals'`,
    { type: QueryTypes.SELECT }
  );
  if (Number(t) === 0) return false; // sync will create it fresh from the model

  const missing = [];
  for (const col of COLUMNS) {
    const [{ c }] = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'patient_vitals'
           AND column_name = :name`,
      { type: QueryTypes.SELECT, replacements: { name: col.name } }
    );
    if (Number(c) === 0) missing.push(col);
  }
  if (!missing.length) return false;

  await sequelize.query(
    `ALTER TABLE patient_vitals ${missing.map((c) => `ADD COLUMN ${c.name} ${c.ddl}`).join(", ")}`
  );
  return true;
}
module.exports = ensureVitalsLocation;
```

Wire it in `server.js` immediately after `ensureReferralColumns(sequelize)`:

```js
const ensureVitalsLocation = require("./db/ensureVitalsLocation");
// …inside the dev boot block, after ensureReferralColumns:
await ensureVitalsLocation(sequelize); // sync() won't ALTER patient_vitals to add `location`.
```

## 3. Model — `models/patientVitals.model.js` 🟡

Add the column (place it near `note`):

```js
note:     { type: DataTypes.STRING(255), allowNull: true },
location: { type: DataTypes.STRING(150), allowNull: true },
source:   { type: DataTypes.ENUM("patient", "doctor"), allowNull: false, defaultValue: "patient" },
```

## 4. Service — `services/patientVitals.service.js` 🟡

One line in `vitalsRow()` (the single source of truth for both the patient- and doctor-write paths):

```js
const vitalsRow = (patientId, body, source) => ({
  patientId,
  recordedOn: body.recordedOn,
  bloodPressure: body.bloodPressure || null,
  pulseRateBpm: body.pulseRateBpm ?? null,
  weightKg: body.weightKg ?? null,
  heightCm: body.heightCm ?? null,
  temperatureF: body.temperatureF ?? null,
  spo2Percent: body.spo2Percent ?? null,
  note: body.note || null,
  location: body.location || null,   // ← NEW
  source,
});
```

Leave `ORDER` newest-first (`recordedOn DESC, createdAt DESC, id DESC`) — the API contract is
unchanged; the frontend controls display order (it reverses to put the newest at the bottom).

## 5. Serializer — `utils/serializers.js` 🟡

Two edits inside `serializePatientVitals` (and its `VITALS_MATRIX_FIELDS`):

**5.1 Re-order `VITALS_MATRIX_FIELDS`** to the requested column order (Date + Location are rendered by
the component as fixed leading columns, so they are **not** in `fields`):

```js
const VITALS_MATRIX_FIELDS = [
  { key: "weightKg",      label: "Weight", unit: "kg" },
  { key: "heightCm",      label: "Height", unit: "cm" },
  { key: "bmi",           label: "BMI",    unit: "",    derived: true },
  { key: "pulseRateBpm",  label: "Pulse",  unit: "bpm" },
  { key: "bloodPressure", label: "BP",     unit: "mmHg" },
  { key: "temperatureF",  label: "Temp",   unit: "°F" },
  { key: "spo2Percent",   label: "SpO₂",   unit: "%" },
];
```

**5.2 Add `location` to each entry** (top-level, alongside `note`/`source` — it is per-reading meta,
not a numeric `values` field; BMI stays derived exactly as today):

```js
return {
  id: String(r.id),
  recordedOn: r.recordedOn,
  source: r.source,
  note: r.note ?? null,
  location: r.location ?? null,   // ← NEW
  values: { /* …bloodPressure, pulseRateBpm, weightKg, heightCm, temperatureF, spo2Percent, bmi… */ },
};
```

## 6. Validator — `validators/patient.validator.js` 🟡

Add `location` to `addVitalsEntry` as **required** (the client picks it from Google Maps). **Do not**
add it to `VITAL_FIELDS` — location is not a vital, so the "≥1 vital" rule still applies on top.

```js
const addVitalsEntry = Joi.object({
  recordedOn: Joi.date().iso().max("now").default(() => new Date()),
  bloodPressure: Joi.string().trim().max(20).allow("", null),
  pulseRateBpm: Joi.number().integer().min(0).max(400).allow(null),
  weightKg: Joi.number().min(0).max(1000).allow(null),
  heightCm: Joi.number().min(0).max(300).allow(null),
  temperatureF: Joi.number().min(0).max(120).allow(null),
  spo2Percent: Joi.number().integer().min(0).max(100).allow(null),
  note: Joi.string().trim().max(255).allow("", null),
  location: Joi.string().trim().min(1).max(150).required().messages({   // ← NEW, required
    "any.required": "Location is required",
    "string.empty": "Location is required",
  }),
}).custom(/* unchanged "≥1 vital" rule; VITAL_FIELDS untouched */);
```

The same schema backs both the patient and doctor add-vitals routes, so both now require a location.

This single schema is used by both the patient route and the doctor route
(`doctorBooking.routes.js` → `validate(patientSchema.addVitalsEntry)`), so both writers accept
`location` with no further change.

---

## 7. Verification (backend)

- **Fresh DB:** `npm run migrate` applies `012`; `patient_vitals` gains `location`.
- **Dev boot:** starting the server runs `sequelize.sync()` + `ensureVitalsLocation` → `location`
  exists on an existing dev DB (idempotent no-op once present).
- **Round-trip:** `POST /patient/vitals { recordedOn, weightKg:72.5, heightCm:176, location:"Home" }`
  → 201; `GET /patient/vitals` → the entry has `location:"Home"` and `values.bmi` computed; `fields`
  are in the new order (Weight, Height, BMI, Pulse, BP, Temp, SpO₂).
- **Rules intact:** `POST /patient/vitals` with no `location` → `422` "Location is required";
  `{ location:"Home" }` with no vital → `422` "Add at least one vital…".
- **Doctor path:** `POST /doctor/bookings/:id/patient-vitals { …, location:"Clinic" }` on a confirmed
  own booking → 201 with the reading tagged `source:"doctor"`.
</content>
