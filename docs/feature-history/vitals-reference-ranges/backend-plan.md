# Vitals Reference Ranges — Backend Plan

**Read `README.md` first — §2 (the research) and §3 (colour semantics) drive everything here.**
Legend: 🟢 exists · 🟡 extend · 🔵 new.

**No migration. No model change.** Bands are configuration; statuses are derived at serialize time and never stored. Storing a status would freeze a clinical threshold into historical rows and make changing a guideline a data migration.

---

## 1. `config/vitalsRanges.js` 🔵 — the single source of truth

### 1.1 Statuses

```js
const VITAL_STATUS = {
  NORMAL:     "normal",
  LOW:        "low",         // below range, not dangerous       → blue
  BORDERLINE: "borderline",  // approaching concern              → amber
  HIGH:       "high",        // above range                      → red
  CRITICAL:   "critical",    // dangerous in EITHER direction    → red + ⚠
  UNKNOWN:    "unknown",     // not evaluated (child, no DOB, unparseable)
};
```

`unknown` is not a failure state — it is the honest answer whenever the range does not apply, and it renders exactly like a normal cell (plain). See README §4.

### 1.2 The guideline switch (README §7-A, §7-D)

```js
/** README §2.1 / §2.5 — flip these two and every surface follows. */
const BP_STANDARD  = "who";   // "who" | "acc_aha"
const BMI_STANDARD = "asian"; // "asian" | "international"
```

### 1.3 Band tables

Each colourable field declares ordered bands, evaluated first-match. Boundaries are **inclusive of `min`, inclusive of `max`** — stated explicitly because §2's clinical thresholds are exact (100.4 °F is fever; 100.3 is not).

```js
pulseRateBpm: {
  unit: "bpm",
  normal: { min: 60, max: 100 },
  bands: [
    { max: 39,               status: CRITICAL, label: "Severe bradycardia" },
    { min: 40,  max: 59,     status: LOW,       label: "Bradycardia" },
    { min: 60,  max: 100,    status: NORMAL,    label: "Normal" },
    { min: 101, max: 120,    status: HIGH,      label: "Tachycardia" },
    { min: 121,              status: CRITICAL,  label: "Marked tachycardia" },
  ],
},
```

Same shape for `temperatureF`, `spo2Percent`, `bmi` — thresholds exactly per README §2.3 / §2.4 / §2.5.

`spo2Percent` has **no high band** (README §2.4): the scale caps at 100, so the table runs `critical (<88) → high-severity low (88–90) → borderline (91–94) → normal (95–100)`. A value >100 is a data error → `UNKNOWN`, not `HIGH`.

`weightKg` and `heightCm` are **absent from the table entirely** (README §2.6/§2.7). A field with no entry evaluates to `UNKNOWN` — so "not colourable" is the default, and adding a field to the table is the deliberate act.

### 1.4 Blood pressure — the compound case

```js
/**
 * Parse a free-text BP string into { systolic, diastolic }, or null.
 * `patient_vitals.blood_pressure` is STRING(20) free text, so this sees
 * "130/85", "130 / 85", "130-85" and outright junk. It must FAIL SAFE:
 * anything it cannot read with confidence returns null → UNKNOWN → no colour.
 * Guessing here would paint a wrong clinical verdict onto a real reading.
 */
function parseBloodPressure(raw) {
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d{2,3})\s*[/\-–]\s*(\d{2,3})\s*$/.exec(raw);
  if (!m) return null;
  const systolic = Number(m[1]);
  const diastolic = Number(m[2]);
  // Physiologically impossible readings are data errors, not hypertension.
  if (systolic < 50 || systolic > 300 || diastolic < 30 || diastolic > 200) return null;
  if (diastolic >= systolic) return null;
  return { systolic, diastolic };
}
```

Status = **the worse of the two sides** (README §2.1), by severity rank `normal < low < borderline < high < critical`. 135/95 is `high` on diastolic alone.

### 1.5 The evaluator

```js
/**
 * Evaluate one field's value. `age` gates on adults only (README §4) — every
 * band in this file is an ADULT range, and applying them to a child would flag
 * a healthy newborn's 140 bpm as marked tachycardia.
 */
function evaluateVital(key, value, { age } = {}) {
  if (value == null || value === "") return { status: UNKNOWN };
  if (age == null || age < 18) return { status: UNKNOWN, reason: "adult_ranges_only" };
  // → { status, label, normal: { min, max } }
}

/** Evaluate a whole entry's values → { [key]: { status, label, normal } }. */
function evaluateEntry(values, { age }) { /* … */ }
```

Returning `normal: { min, max }` alongside the status is what lets the frontend tooltip say *"High — normal is 60–100 bpm"* without duplicating a single number.

---

## 2. `utils/serializers.js` 🟡

### 2.1 `VITALS_MATRIX_FIELDS` gains `bands`

The existing array already ships `{ key, label, unit }` to both apps. Add the normal range so a client can render a legend or an axis without asking again:

```js
{ key: "pulseRateBpm", label: "Pulse", unit: "bpm", normal: { min: 60, max: 100 } },
{ key: "weightKg",     label: "Weight", unit: "kg" },   // no `normal` ⇒ never coloured
```

Purely additive — existing consumers ignore it.

### 2.2 `serializePatientVitals(rows, { age })` 🟡

Each entry gains a sibling `statuses` map alongside `values`:

```jsonc
{
  "recordedOn": "2026-07-14",
  "values":   { "pulseRateBpm": 112, "spo2Percent": 89, "bloodPressure": "150/95", "weightKg": 72, "bmi": 24.6 },
  "statuses": {
    "pulseRateBpm":  { "status": "high",     "label": "Tachycardia",   "normal": { "min": 60,   "max": 100 } },
    "spo2Percent":   { "status": "critical", "label": "Hypoxemia",     "normal": { "min": 95,   "max": 100 } },
    "bloodPressure": { "status": "high",     "label": "Hypertension",  "normal": { "min": null, "max": null } },
    "weightKg":      { "status": "unknown" },
    "bmi":           { "status": "high",     "label": "Overweight",    "normal": { "min": 18.5, "max": 22.9 } }
  }
}
```

**Parallel map, not enriched values.** Keeping `values` untouched means every existing consumer — the prescription prefill in `RxComposer`, the render view, the PDF — keeps working with zero changes. Nesting `{ value, status }` inside `values` would break all of them.

The signature gains an options bag rather than a positional arg, so callers that don't have an age (and should therefore get `unknown`) stay correct by default.

---

## 3. `services/patientVitals.service.js` 🟡 — supplying age

The serializer needs the patient's age. `patient_profiles.date_of_birth` already exists and `prescription.service.ageFrom(dob)` already computes whole years — **reuse it**, don't write a second age function.

Load the DOB **once per request**, alongside the vitals rows (not per entry — that would be an N+1 over a list that is already loaded):

```js
const [rows, profile] = await Promise.all([
  PatientVitals.findAll({ where: { patientId }, order: [["recordedOn", "ASC"]] }),
  PatientProfile.findByPk(patientId, { attributes: ["dateOfBirth"] }),
]);
return serializePatientVitals(rows, { age: ageFrom(profile?.dateOfBirth) });
```

Age is computed **as of today**, not as of `recordedOn`. A reading from when the patient was 17 is evaluated against adult ranges once they turn 18. This is a deliberate simplification for v1 — using age-at-reading is more correct and is noted as a follow-up.

Every read path that serializes vitals must pass age, or it silently degrades to `unknown` everywhere:
- `GET /patient/vitals` (patient's own)
- `GET /doctor/bookings/:id/patient-vitals` (doctor's view of the same patient)

Both must produce **identical** statuses for the same reading. A doctor and a patient seeing different verdicts on one number is the specific failure this feature exists to prevent.

---

## 4. `config/swagger.js` 🟡

Extend the vitals matrix schema with `normal` on fields and the `statuses` map on entries. Document the enum, and state plainly that `unknown` means *not evaluated* (child, missing DOB, or unparseable) — **not** *normal*.

---

## 5. Testing

The value of this feature is entirely in the boundaries. A test table over exact edges, both sides:

| Field | Cases |
|---|---|
| Temp | 100.3 → borderline · **100.4 → high** · 94.9 → critical · 95.0 → low · 96.8 → normal |
| SpO₂ | 94 → borderline · **95 → normal** · 90 → high-severity low · 87 → critical · 101 → unknown |
| Pulse | 59 → low · **60 → normal** · 100 → normal · 101 → high · 121 → critical |
| BMI (asian) | 22.9 → normal · **23.0 → high** · 18.4 → low · 18.5 → normal |
| BP | "130/85" → normal (WHO) · "140/90" → high · "89/58" → low · "130-85" → parsed · "abc" → unknown · "85/130" → unknown |
| Age gate | age 17 → every field unknown · DOB null → every field unknown |

Also assert the guideline switches: flipping `BMI_STANDARD` to `"international"` moves 23.0 from `high` to `normal`, and flipping `BP_STANDARD` moves 130/85.
