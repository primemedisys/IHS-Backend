/**
 * Period math for the dashboards (docs/dashboards-earnings/backend-plan.md §3).
 *
 * Everything a user calls "today" or "this month" is an Asia/Kolkata boundary;
 * everything in the DB is UTC. This module is the ONLY place that conversion
 * lives, so the tiles, the series and the ledger can never disagree about where
 * a month ends.
 *
 * India has no DST, so IST is a constant +05:30 — the arithmetic below is exact,
 * not an approximation.
 */
const ApiError = require("./ApiError");
const {
  DASHBOARD_DEFAULT_MONTHS,
  DASHBOARD_MAX_DAYS,
} = require("../config/constants");

/** +05:30 in milliseconds. */
const IST_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shift a UTC instant into "IST wall-clock, expressed as a UTC Date". */
const toIstWall = (d) => new Date(d.getTime() + IST_MS);
/** The inverse: an IST wall-clock Date back to the real UTC instant. */
const fromIstWall = (d) => new Date(d.getTime() - IST_MS);

/** Current IST calendar date as 'YYYY-MM-DD' — what `slot_date = today` means. */
function istToday(now = new Date()) {
  return toIstWall(now).toISOString().slice(0, 10);
}

/**
 * Start (inclusive) and end (exclusive) UTC instants of the IST month `now`
 * falls in. Half-open, always: `paid_at < to` never double-counts the boundary
 * instant the way `BETWEEN` does.
 */
function istMonthBounds(now = new Date()) {
  const wall = toIstWall(now);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1);
  const endWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1);
  return { from: fromIstWall(new Date(startWall)), to: fromIstWall(new Date(endWall)) };
}

/** The IST day `now` falls in, as a half-open UTC range. */
function istDayBounds(now = new Date()) {
  const wall = toIstWall(now);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return {
    from: fromIstWall(new Date(startWall)),
    to: fromIstWall(new Date(startWall + DAY_MS)),
  };
}

/**
 * Resolve a validated `{ from, to, granularity }` into a concrete half-open UTC
 * range. Defaults to the trailing DASHBOARD_DEFAULT_MONTHS ending at the end of
 * the current IST month.
 *
 * The `day`-granularity width cap lives HERE rather than in the Joi schema
 * because the constraint is on the COMBINATION of from, to and granularity —
 * a validator that sees one field at a time can't express it.
 */
function resolveRange({ from, to, granularity = "month" } = {}) {
  const monthNow = istMonthBounds();
  const end = to ? new Date(to) : monthNow.to;

  let start;
  if (from) {
    start = new Date(from);
  } else {
    const wall = toIstWall(end);
    // Step back N months from the end, in IST wall-clock terms.
    start = fromIstWall(
      new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - DASHBOARD_DEFAULT_MONTHS, 1))
    );
  }

  if (start >= end) {
    throw ApiError.badRequest("`from` must be before `to`");
  }
  if (granularity === "day" && (end - start) / DAY_MS > DASHBOARD_MAX_DAYS) {
    throw ApiError.badRequest(
      `A day-by-day series is capped at ${DASHBOARD_MAX_DAYS} days — narrow the range or use granularity=month`
    );
  }

  return { from: start, to: end, granularity };
}

/** 'YYYY-MM-DD' of the Monday that starts the IST week a wall-clock Date is in. */
function weekStartKey(wall) {
  const dayStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const sinceMonday = (wall.getUTCDay() + 6) % 7;
  return new Date(dayStart - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The IST bucket key a UTC instant belongs to, for a given granularity:
 * 'YYYY-MM-DD' (day), the Monday 'YYYY-MM-DD' (week) or 'YYYY-MM' (month).
 */
function bucketKey(date, granularity) {
  const wall = toIstWall(date);
  if (granularity === "week") return weekStartKey(wall);
  const iso = wall.toISOString();
  return granularity === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** Every bucket key in [from, to), in order. */
function bucketKeys({ from, to, granularity }) {
  const keys = [];
  if (granularity === "week") {
    // Monday-start IST weeks, from the week `from` falls in.
    let cursor = Date.parse(`${weekStartKey(toIstWall(from))}T00:00:00Z`);
    while (fromIstWall(new Date(cursor)) < to) {
      keys.push(new Date(cursor).toISOString().slice(0, 10));
      cursor += 7 * DAY_MS;
    }
  } else if (granularity === "day") {
    // Walk IST midnights so a DST-free +05:30 shift can't skip or repeat a day.
    const wall = toIstWall(from);
    let cursor = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
    while (fromIstWall(new Date(cursor)) < to) {
      keys.push(new Date(cursor).toISOString().slice(0, 10));
      cursor += DAY_MS;
    }
  } else {
    const wall = toIstWall(from);
    let y = wall.getUTCFullYear();
    let m = wall.getUTCMonth();
    while (fromIstWall(new Date(Date.UTC(y, m, 1))) < to) {
      keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }
  return keys;
}

/**
 * Fill the holes in a sparse aggregate. SQL returns only buckets that HAVE rows;
 * a chart needs a point for every bucket in the range — a month with no consults
 * is a ₹0 bar, not a missing bar that silently shortens the axis.
 *
 * Zero-filled in JS, not SQL: MySQL has no `generate_series`, and the recursive
 * CTE that emulates it is slower and far harder to read than a Map lookup.
 *
 * @param rows  raw aggregate rows, each carrying a `bucket` key
 * @param shape the zero row for an empty bucket, e.g. { gross: 0, net: 0 }
 */
function zeroFill(rows, { from, to, granularity, shape }) {
  const byBucket = new Map(rows.map((r) => [String(r.bucket), r]));
  return bucketKeys({ from, to, granularity }).map((bucket) => {
    const hit = byBucket.get(bucket);
    return hit ? { ...shape, ...hit, bucket } : { bucket, ...shape };
  });
}

/**
 * A validated 'YYYY-MM-DD' IST date range (inclusive `to`) as the half-open
 * UTC instants a DATETIME query needs.
 */
function istDateRangeBounds(fromDay, toDay) {
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`) + DAY_MS;
  return { from: fromIstWall(new Date(start)), to: fromIstWall(new Date(end)) };
}

/** Shift an IST 'YYYY-MM-DD' by whole days. */
function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

module.exports = {
  istToday,
  istDateRangeBounds,
  addDays,
  istMonthBounds,
  istDayBounds,
  resolveRange,
  bucketKey,
  bucketKeys,
  zeroFill,
};
