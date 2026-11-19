/**
 * Pure date / schedule helpers for patient medicine routines (migration 055).
 * No DB access — the service and the reminder sweep both use these, so a dose
 * time is computed exactly one way.
 *
 * Times are stored as the patient's local wall clock ("08:00") plus an IANA
 * time zone; dose rows carry the resulting UTC instant. Conversion uses the
 * built-in Intl API (no extra dependency) and handles DST zones correctly.
 */
const { FREQUENCY_DAILY_COUNT } = require("../config/constants");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsCache = new Map();
function formatterFor(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** The wall-clock parts of `date` in `tz`. */
function zonedParts(date, tz) {
  const out = {};
  for (const p of formatterFor(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Offset of `tz` at instant `date`, in ms (local − UTC). */
function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Local "YYYY-MM-DD" + "HH:MM" in `tz` → the UTC Date of that moment. */
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(new Date(guess), tz);
  let utc = guess - first;
  const second = offsetMs(new Date(utc), tz);
  if (second !== first) utc = guess - second; // crossed a DST boundary
  return new Date(utc);
}

const pad = (n) => String(n).padStart(2, "0");

/** The calendar date of instant `date` in `tz`, as "YYYY-MM-DD". */
function localDate(date, tz) {
  const p = zonedParts(date instanceof Date ? date : new Date(date), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD" + n days. */
function addDays(dateStr, n) {
  const t = Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** 0 (Sun) … 6 (Sat) for a "YYYY-MM-DD". */
function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** Inclusive end date of a course of `durationDays` starting `startDate`; null = ongoing. */
function endDateFor(startDate, durationDays) {
  return durationDays ? addDays(startDate, Number(durationDays) - 1) : null;
}

/** A prescription line's duration (count + unit) in days; null when not given. */
function durationToDays(count, unit) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const per = unit === "week" ? 7 : unit === "month" ? 30 : 1;
  return Math.min(n * per, 3650);
}

/** A JSON column value as an array (some drivers hand JSON back as a string). */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Valid "HH:MM" strings, de-duplicated and sorted. */
function normalizeTimes(value) {
  const times = asArray(value);
  if (!times) return [];
  return [...new Set(times.filter((t) => typeof t === "string" && TIME_RE.test(t)))].sort();
}

/** Valid weekday numbers, de-duplicated and sorted; null (= every day) when empty / all 7. */
function normalizeDays(value) {
  const days = asArray(value);
  if (!days) return null;
  const list = [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return list.length === 0 || list.length === 7 ? null : list;
}

/**
 * How many reminder times a frequency suggests per day — a hint for the UI,
 * never a dose. "OD" → 1, "BD" → 2, "1-0-1" → 2; SOS / weekly / free text → null.
 */
function suggestedDailyCount(frequency) {
  const f = String(frequency ?? "").trim().toUpperCase();
  if (!f) return null;
  if (FREQUENCY_DAILY_COUNT[f]) return FREQUENCY_DAILY_COUNT[f];
  if (/^[0-9½.]+(-[0-9½.]+){2,3}$/.test(f)) {
    const n = f.split("-").filter((x) => x !== "0").length;
    return n || null;
  }
  return null;
}

/**
 * The dose slots of `routine` with local dates in [fromDate, toDate] (inclusive),
 * clipped to the routine's own start / end dates. Returns
 * `{ scheduledDate, scheduledTime, scheduledAt }[]` — no DB rows.
 */
function occurrencesFor(routine, fromDate, toDate) {
  const times = normalizeTimes(routine.reminderTimes);
  if (!times.length) return [];
  const tz = isValidTimeZone(routine.timezone) ? routine.timezone : "Asia/Kolkata";
  const start = routine.startDate > fromDate ? routine.startDate : fromDate;
  const end = routine.endDate && routine.endDate < toDate ? routine.endDate : toDate;
  const days = normalizeDays(routine.daysOfWeek);
  const out = [];
  for (let d = start, guard = 0; d <= end && guard < 400; d = addDays(d, 1), guard += 1) {
    if (days && !days.includes(weekday(d))) continue;
    for (const t of times) out.push({ scheduledDate: d, scheduledTime: t, scheduledAt: zonedToUtc(d, t, tz) });
  }
  return out;
}

/** The strength suffix of a printed label: "Pan 40 40 mg" + "40 mg" → "Pan 40". */
function baseMedicineName(label, strength) {
  const n = String(label ?? "").trim();
  const s = String(strength ?? "").trim();
  return s && n.toLowerCase().endsWith(` ${s.toLowerCase()}`) ? n.slice(0, -(s.length + 1)).trim() : n;
}

/** Comparison key for "the same medicine" across prescription versions. */
function medicineKey(name, strength) {
  const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  return `${norm(name)}|${norm(strength)}`;
}

module.exports = {
  TIME_RE,
  DATE_RE,
  isValidTimeZone,
  zonedToUtc,
  localDate,
  addDays,
  weekday,
  endDateFor,
  durationToDays,
  normalizeTimes,
  normalizeDays,
  suggestedDailyCount,
  occurrencesFor,
  baseMedicineName,
  medicineKey,
};
