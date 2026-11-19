/**
 * Clinical reference ranges for vitals (docs/vitals-reference-ranges §2).
 *
 * THE SINGLE SOURCE OF TRUTH. The same record table is rendered by
 * frontend-patient and frontend-doctor, each with its own copy of
 * HealthRecordTable — duplicating thresholds there would eventually let a
 * doctor and a patient see different verdicts on the same number, which is the
 * exact failure this feature exists to prevent. Frontends map STATUS → colour
 * and nothing else.
 *
 * Two things the research changed about the naive "high = red, low = blue" rule
 * (README §3), both load-bearing:
 *
 *   1. Colour encodes SEVERITY, not direction. SpO₂ 85 % and 94 °F are
 *      emergencies at the LOW end; painting them the same calm blue as a
 *      healthy athlete's 56 bpm pulse would be actively misleading.
 *   2. Only 5 of the 7 fields are colourable. Weight has no normal range
 *      independent of height (the signal is BMI, already derived in the
 *      serializer) and adult height has none at all. Fields absent from
 *      `BANDS` evaluate to `unknown` — so "not colourable" is the default and
 *      adding a field is a deliberate act.
 *
 * Everything here is an ADULT range. `evaluate()` refuses to apply them under
 * 18 (§4): a newborn's normal pulse is 100–160 bpm, and flagging every healthy
 * infant as critically tachycardic is worse than showing no colour at all.
 *
 * Decision-support only — never a diagnosis (§6).
 */

/** Status vocabulary. `unknown` is an honest "not evaluated", not a verdict. */
const VITAL_STATUS = Object.freeze({
  NORMAL: "normal",
  LOW: "low", // below range, NOT dangerous        → blue
  BORDERLINE: "borderline", // approaching concern → amber
  HIGH: "high", // above range                     → red
  CRITICAL: "critical", // dangerous EITHER way    → red + ⚠
  UNKNOWN: "unknown", // child, no DOB, unparseable, or not a colourable field
});

const { NORMAL, LOW, BORDERLINE, HIGH, CRITICAL, UNKNOWN } = VITAL_STATUS;

/** Severity rank — used to take "the worse of" two numbers (BP). */
const SEVERITY = Object.freeze({
  [UNKNOWN]: -1,
  [NORMAL]: 0,
  [LOW]: 1,
  [BORDERLINE]: 2,
  [HIGH]: 3,
  [CRITICAL]: 4,
});

/** Adults only. Below this every field reports `unknown` (§4). */
const ADULT_AGE = 18;

// ── Guideline switches (README §7-A, §7-D) ───────────────────────────────────
/**
 * "who"     → WHO/ISH, ESC/ESH and Indian practice (ICMR/API): hypertension ≥140/90.
 * "acc_aha" → ACC/AHA 2017: stage-1 hypertension from 130/80.
 * WHO is the default: ACC/AHA would flag a very large share of ordinary Indian
 * adults as hypertensive on a consumer-facing screen.
 */
const BP_STANDARD = "who";

/**
 * "asian"         → WHO Asia-Pacific / ICMR: overweight ≥23, obese ≥25.
 * "international" → WHO: overweight ≥25, obese ≥30.
 * Asian is the default: Indians carry higher body-fat and cardiometabolic risk
 * at a given BMI, and this platform serves that population.
 */
const BMI_STANDARD = "asian";

// ── Band tables ──────────────────────────────────────────────────────────────
// First match wins. `min`/`max` are BOTH INCLUSIVE — stated explicitly because
// the clinical thresholds are exact: 100.4 °F is fever, 100.3 °F is not.
const BANDS = {
  pulseRateBpm: {
    normal: { min: 60, max: 100 },
    bands: [
      { max: 39, status: CRITICAL, label: "Severe bradycardia" },
      { min: 40, max: 59, status: LOW, label: "Bradycardia" },
      { min: 60, max: 100, status: NORMAL, label: "Normal" },
      { min: 101, max: 120, status: HIGH, label: "Tachycardia" },
      { min: 121, status: CRITICAL, label: "Marked tachycardia" },
    ],
  },

  temperatureF: {
    normal: { min: 96.8, max: 99.0 },
    bands: [
      { max: 94.99, status: CRITICAL, label: "Hypothermia" },
      { min: 95.0, max: 96.7, status: LOW, label: "Below normal" },
      { min: 96.8, max: 99.0, status: NORMAL, label: "Normal" },
      { min: 99.1, max: 100.3, status: BORDERLINE, label: "Low-grade fever" },
      // 100.4 °F / 38.0 °C is THE clinical fever definition (WHO/CDC).
      { min: 100.4, max: 105.9, status: HIGH, label: "Fever" },
      { min: 106.0, status: CRITICAL, label: "Hyperpyrexia" },
    ],
  },

  spo2Percent: {
    normal: { min: 95, max: 100 },
    // One-sided by nature: the scale caps at 100, so there is no "high" band.
    // The dangerous direction is DOWN, which is why 88–90 is HIGH severity and
    // <88 is CRITICAL — never `low`/blue.
    bands: [
      { max: 87, status: CRITICAL, label: "Severe hypoxemia" },
      { min: 88, max: 90, status: HIGH, label: "Hypoxemia" },
      { min: 91, max: 94, status: BORDERLINE, label: "Mild hypoxemia" },
      { min: 95, max: 100, status: NORMAL, label: "Normal" },
      // >100 is impossible — a data error, not a finding.
      { min: 101, status: UNKNOWN, label: "Out of range" },
    ],
  },

  // Adult resting respiratory rate (breaths/min), migration 051. Banded like
  // the NEWS2 early-warning score: 12–20 normal, ≤ 8 or ≥ 25 dangerous.
  respiratoryRate: {
    normal: { min: 12, max: 20 },
    bands: [
      { max: 8, status: CRITICAL, label: "Severe bradypnoea" },
      { min: 9, max: 11, status: LOW, label: "Bradypnoea" },
      { min: 12, max: 20, status: NORMAL, label: "Normal" },
      { min: 21, max: 24, status: HIGH, label: "Tachypnoea" },
      { min: 25, status: CRITICAL, label: "Marked tachypnoea" },
    ],
  },

  bmi: {
    asian: {
      normal: { min: 18.5, max: 22.9 },
      bands: [
        { max: 18.49, status: LOW, label: "Underweight" },
        { min: 18.5, max: 22.9, status: NORMAL, label: "Normal" },
        { min: 23.0, max: 24.9, status: HIGH, label: "Overweight" },
        { min: 25.0, status: CRITICAL, label: "Obese" },
      ],
    },
    international: {
      normal: { min: 18.5, max: 24.9 },
      bands: [
        { max: 18.49, status: LOW, label: "Underweight" },
        { min: 18.5, max: 24.9, status: NORMAL, label: "Normal" },
        { min: 25.0, max: 29.9, status: HIGH, label: "Overweight" },
        { min: 30.0, status: CRITICAL, label: "Obese" },
      ],
    },
  },
};

/** BP thresholds per standard. Applied to systolic and diastolic separately. */
const BP_THRESHOLDS = {
  who: {
    normal: { systolic: 130, diastolic: 85 }, // strictly below = normal
    borderline: { systolic: 139, diastolic: 89 }, // up to = high-normal
    crisis: { systolic: 180, diastolic: 120 },
  },
  acc_aha: {
    normal: { systolic: 120, diastolic: 80 },
    borderline: { systolic: 139, diastolic: 89 },
    crisis: { systolic: 180, diastolic: 120 },
  },
};

const HYPOTENSION = { systolic: 90, diastolic: 60 }; // strictly below = low

// ── Evaluation ───────────────────────────────────────────────────────────────
/** Resolve the band table for a key, honouring the guideline switches. */
function tableFor(key) {
  if (key === "bmi") return BANDS.bmi[BMI_STANDARD];
  // A measured heart rate shares the adult resting pulse range (60–100 bpm).
  if (key === "heartRateBpm") return BANDS.pulseRateBpm;
  return BANDS[key];
}

function matchBand(table, value) {
  for (const b of table.bands) {
    if (b.min != null && value < b.min) continue;
    if (b.max != null && value > b.max) continue;
    return b;
  }
  return null;
}

/**
 * Parse free-text blood pressure into { systolic, diastolic }, or null.
 *
 * `patient_vitals.blood_pressure` is a STRING(20) the patient types, so this
 * sees "130/85", "130 / 85", "130-85" and outright junk. It MUST fail safe:
 * anything it cannot read with confidence returns null → `unknown` → no colour.
 * Guessing would paint a wrong clinical verdict onto a real reading.
 */
function parseBloodPressure(raw) {
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d{2,3})\s*[/\-–]\s*(\d{2,3})\s*$/.exec(raw);
  if (!m) return null;
  const systolic = Number(m[1]);
  const diastolic = Number(m[2]);
  // Physiologically impossible readings are data errors, not hypertension.
  if (systolic < 50 || systolic > 300) return null;
  if (diastolic < 30 || diastolic > 200) return null;
  if (diastolic >= systolic) return null;
  return { systolic, diastolic };
}

/** One side of a BP reading → { status, label }. */
function bpSide(value, side) {
  const t = BP_THRESHOLDS[BP_STANDARD];
  if (value > t.crisis[side]) return { status: CRITICAL, label: "Hypertensive crisis" };
  if (value > t.borderline[side]) return { status: HIGH, label: "Hypertension" };
  if (value >= t.normal[side]) return { status: BORDERLINE, label: "High-normal" };
  if (value < HYPOTENSION[side]) return { status: LOW, label: "Hypotension" };
  return { status: NORMAL, label: "Normal" };
}

/** Blood pressure — the WORSE of systolic and diastolic (135/95 is high on DIA). */
function evaluateBloodPressure(raw) {
  const parsed = parseBloodPressure(raw);
  if (!parsed) return { status: UNKNOWN };
  const sys = bpSide(parsed.systolic, "systolic");
  const dia = bpSide(parsed.diastolic, "diastolic");
  const worse = SEVERITY[dia.status] > SEVERITY[sys.status] ? dia : sys;
  return { status: worse.status, label: worse.label };
}

/**
 * Evaluate one field's value against its adult reference range.
 *
 * @param {string} key   a VITALS_MATRIX_FIELDS key
 * @param {*} value      the raw value (string for BP, number otherwise)
 * @param {{ age?: number|null }} ctx
 * @returns {{ status: string, label?: string, normal?: { min: number, max: number } }}
 */
function evaluate(key, value, { age } = {}) {
  if (value == null || value === "") return { status: UNKNOWN };
  // Adults only (§4). A missing DOB is also `unknown` — we do not guess an age
  // in order to render a clinical verdict.
  if (age == null || age < ADULT_AGE) return { status: UNKNOWN, reason: "adult_ranges_only" };

  if (key === "bloodPressure") return evaluateBloodPressure(value);

  const table = tableFor(key);
  if (!table) return { status: UNKNOWN }; // weight, height, anything unlisted

  const num = Number(value);
  if (!Number.isFinite(num)) return { status: UNKNOWN };

  const band = matchBand(table, num);
  if (!band || band.status === UNKNOWN) return { status: UNKNOWN };
  return { status: band.status, label: band.label, normal: table.normal };
}

/** Evaluate a whole entry's `values` map → `{ [key]: { status, … } }`. */
function evaluateEntry(values = {}, ctx = {}) {
  const out = {};
  for (const key of Object.keys(values)) out[key] = evaluate(key, values[key], ctx);
  return out;
}

/** The normal range a field advertises on the matrix `fields` array (or null). */
function normalRangeFor(key) {
  if (key === "bloodPressure") {
    const t = BP_THRESHOLDS[BP_STANDARD];
    return { min: null, max: null, display: `< ${t.normal.systolic}/${t.normal.diastolic}` };
  }
  return tableFor(key)?.normal ?? null;
}

module.exports = {
  VITAL_STATUS,
  ADULT_AGE,
  BP_STANDARD,
  BMI_STANDARD,
  evaluate,
  evaluateEntry,
  normalRangeFor,
  parseBloodPressure,
};
