# Backend Plan — Blood Pressure Split Input + Vitals Deduplication

**Date:** 15-09-2026
**Scope:** Backend only (`backend/`)
**Status:** ✅ Implemented

---

## 1. Overview

This document covers the backend changes for:
1. Removing duplicate vitals (BP, Weight, Height) from the PDF body section
2. Verifying no API changes are needed for the BP split input

---

## 2. Changes Made

### 2.1 `prescriptionPdf.service.js` — PDF Renderer

**Location:** `backend/src/services/prescriptionPdf.service.js`

**Function modified:** `vitalsHtml()` (lines 192-205)

**Before:**
```js
function vitalsHtml(v) {
  const parts = [
    v.bloodPressure && ["BP", v.bloodPressure],
    v.pulseRateBpm && ["Pulse", `${v.pulseRateBpm} bpm`],
    v.weightKg && ["Wt", `${v.weightKg} kg`],
    v.heightCm && ["Ht", `${v.heightCm} cm`],
    v.temperatureF && ["Temp", `${v.temperatureF} °F`],
    v.spo2Percent && ["SpO2", `${v.spo2Percent}%`],
  ].filter(Boolean);

  if (!parts.length) return "";
  return `<div class="section"><div class="section__label">Vitals</div><div class="vitals">${parts
    .map(([k, val]) => `<span>${esc(k)}: <b>${esc(val)}</b></span>`)
    .join("")}</div></div>`;
}
```

**After:**
```js
function vitalsHtml(v) {
  // BP, Weight, Height are already shown in the patient strip header —
  // only include vitals that aren't duplicated there.
  const parts = [
    v.pulseRateBpm && ["Pulse", `${v.pulseRateBpm} bpm`],
    v.temperatureF && ["Temp", `${v.temperatureF} °F`],
    v.spo2Percent && ["SpO2", `${v.spo2Percent}%`],
  ].filter(Boolean);

  if (!parts.length) return "";
  return `<div class="section"><div class="section__label">Vitals</div><div class="vitals">${parts
    .map(([k, val]) => `<span>${esc(k)}: <b>${esc(val)}</b></span>`)
    .join("")}</div></div>`;
}
```

**What changed:**
- Removed `v.bloodPressure && ["BP", v.bloodPressure]`
- Removed `v.weightKg && ["Wt", `${v.weightKg} kg`]`
- Removed `v.heightCm && ["Ht", `${v.heightCm} cm`]`
- Added comment explaining why these are removed

**What stayed the same:**
- `v.pulseRateBpm` (Pulse) — kept in body vitals
- `v.temperatureF` (Temperature) — kept in body vitals
- `v.spo2Percent` (SpO2) — kept in body vitals
- HTML structure and CSS classes
- Escaping logic (`esc()`)

---

## 3. What Did NOT Change

### 3.1 API Contract

No API endpoints were modified. The existing endpoints continue to work:

| Endpoint | Method | Change |
|---|---|---|
| `/doctor/prescriptions/:id` | GET | None |
| `/doctor/prescriptions/:id` | PATCH | None |
| `/doctor/prescriptions/:id/finalize` | POST | None |
| `/doctor/prescriptions/:id/pdf` | GET | None |

The `vitals.bloodPressure` field continues to accept and return `"120/56"` strings.

### 3.2 Backend Validation

No changes to validators:

```js
// prescription.validator.js — UNCHANGED
bloodPressure: SAFE(20).allow("", null)

// patient.validator.js — UNCHANGED
bloodPressure: Joi.string().trim().max(20).allow("", null)

// clinicalNote.validator.js — UNCHANGED
bloodPressure: Joi.string().trim().max(20).allow("", null)
```

### 3.3 Data Serialization

No changes to `prescription.service.js`:

```js
// buildRenderView() — UNCHANGED
const vitals = {
  heightCm: rx.heightCm,
  weightKg: rx.weightKg,
  bloodPressure: rx.bloodPressure,
  pulseRateBpm: rx.pulseRateBpm,
  temperatureF: rx.temperatureF,
  spo2Percent: rx.spo2Percent,
};

return {
  // ...
  patient: {
    bp: rx.bloodPressure ?? "",
    pulse: rx.pulseRateBpm != null ? String(rx.pulseRateBpm) : "",
    weight: rx.weightKg != null ? String(rx.weightKg) : "",
    height: rx.heightCm != null ? String(rx.heightCm) : "",
    // ...
  },
  vitals,
  // ...
};
```

The `patient.bp` field in the header strip still receives the full `"120/56"` value.

### 3.4 Database Schema

No migrations needed. The `blood_pressure` column remains `VARCHAR(20)`:

```sql
-- prescriptions table — UNCHANGED
blood_pressure VARCHAR(20) NULL

-- clinical_notes table — UNCHANGED
blood_pressure VARCHAR(20) NULL

-- patient_vitals table — UNCHANGED
blood_pressure VARCHAR(20) NULL
```

---

## 4. PDF Rendering Flow

### 4.1 Header Patient Strip

The patient strip is rendered by `patientStripHtml()` (lines 127-159). This function is **unchanged** — it continues to render all enabled fields including BP.

```
Header Patient Strip:
┌─────────────────────────────────────────────────────────┐
│  Name: Ramananda  Age/Sex: 28/M  BP: 130/85  Pulse: 78 │
│  Wt: 72 kg  Ht: 171 cm  Temp: 98.4 °F                  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Body Vitals Section

The body vitals are rendered by `vitalsHtml()` (lines 192-205). This function was **modified** to exclude BP, Weight, and Height.

```
Body Vitals Section (AFTER):
┌─────────────────────────────────────────────────────────┐
│  VITALS                                                 │
│  Pulse: 78 bpm  Temp: 98.4 °F  SpO2: 98%               │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Complete PDF Layout

```
┌─────────────────────────────────────────────────────────┐
│  HEADER (doctor info + logo)                            │
├─────────────────────────────────────────────────────────┤
│  PATIENT STRIP                                          │
│  Name: Ramananda  Age/Sex: 28/M  BP: 130/85            │
│  Pulse: 78  Wt: 72 kg  Ht: 171 cm  Temp: 98.4 °F      │
├─────────────────────────────────────────────────────────┤
│  Rx No: OSC-2026-000123    Date: 15 Sep 2026           │
│                                                         │
│  VITALS                                                 │
│  Pulse: 78 bpm  Temp: 98.4 °F  SpO2: 98%               │
│                                                         │
│  Chief complaint                                        │
│  Low back pain radiating to the left leg, 3 weeks      │
│                                                         │
│  ℞                                                      │
│  Medicine    Dosage    Frequency                        │
│  Tab. Etoricoxib 90mg  1 tab  OD                       │
│  ...                                                    │
│                                                         │
│  Advice                                                 │
│  Avoid forward bending and heavy lifting.               │
│                                                         │
│                          ______________                 │
│                          Dr. Puspak Samal               │
├─────────────────────────────────────────────────────────┤
│  FOOTER (contact info)                                  │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Sample Data

The `SAMPLE_RX` constant (lines 522-558) is **unchanged**:

```js
const SAMPLE_RX = {
  // ...
  patient: {
    bp: "130/85",
    pulse: "78",
    weight: "72",
    height: "171",
    temperature: "98.4",
    spo2: "98",
  },
  vitals: {
    bloodPressure: "130/85",
    pulseRateBpm: 78,
    weightKg: 72,
    heightCm: 171,
    temperatureF: 98.4,
    spo2Percent: 98,
  },
  // ...
};
```

The sample data still includes BP/Weight/Height — they appear in the header strip but not in the body vitals section.

---

## 6. Edge Cases

### 6.1 Empty Vitals

If all vitals are null/empty, `vitalsHtml()` returns `""` (empty string) — the entire Vitals section is omitted from the PDF.

### 6.2 Only Body Vitals Present

If only Pulse/Temperature/SpO2 are set (no BP/Weight/Height), the body Vitals section shows only those fields.

### 6.3 Only Header Vitals Present

If only BP/Weight/Height are set (no Pulse/Temperature/SpO2), the body Vitals section is omitted entirely.

---

## 7. Files Summary

| File | Lines Changed | Type |
|---|---|---|
| `prescriptionPdf.service.js` | -3 lines | Modified (removed vitals) |
| **Total** | -3 lines | — |

---

## 8. Testing

### 8.1 PDF Render Test

```bash
# Generate a test PDF
curl -X GET http://localhost:5000/api/doctor/prescriptions/:id/pdf \
  -H "Authorization: Bearer $TOKEN" \
  --output test.pdf

# Verify:
# - Header shows BP: 120/56, Pulse: 78, Wt: 72, Ht: 171
# - Body Vitals shows only Pulse, Temp, SpO2
# - No duplicate BP/Weight/Height in body
```

### 8.2 Template Editor Preview

```bash
# Generate a preview PDF
curl -X GET http://localhost:5000/api/doctor/prescription-templates/:id/preview.pdf \
  -H "Authorization: Bearer $TOKEN" \
  --output preview.pdf

# Verify:
# - Sample data shows BP: 130/85 in header
# - Body Vitals shows only Pulse, Temp, SpO2
```

### 8.3 Backward Compatibility

```bash
# Load an existing prescription
curl -X GET http://localhost:5000/api/doctor/prescriptions/:id \
  -H "Authorization: Bearer $TOKEN"

# Verify:
# - vitals.bloodPressure = "130/80" (existing value)
# - patient.bp = "130/80" (header strip value)
# - PDF renders correctly with existing data
```
