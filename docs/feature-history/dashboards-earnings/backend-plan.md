# Backend — Dashboards & Earnings

The read layer over `bookings` + `payments`, plus the two correctness fixes that must land before any aggregate is trustworthy. Read `README.md §3–5` first — the money model and the metric dictionary are the specification; this file is how it's built.

Follows `.claude/skills/backend-conventions`: `route → validate → authenticate → authorize → controller → service → model`, Joi-only validation, thin controllers, no queries in loops, serialize before responding, swagger in lockstep.

---

## 1. What lands where

```
backend/src/
  db/migrations/007_earnings_indexes.sql   NEW  indexes + refund columns + backfill
  config/constants.js                      EDIT dashboard/earnings enums
  models/payment.model.js                  EDIT refundedAt, refundAmount
  services/payment.service.js              EDIT applySplit() extracted + exported
  services/booking.service.js              EDIT markPaid() calls applySplit()
  services/earnings.service.js             NEW  doctor + admin money aggregates
  services/dashboard.service.js            NEW  patient + doctor + admin tiles
  validators/dashboard.validator.js        NEW  the period/pagination query schema
  controllers/dashboard.controller.js      NEW  patient + doctor + admin summaries
  controllers/earnings.controller.js       NEW  summary / series / transactions
  routes/doctorDashboard.routes.js         NEW  mounted under /doctor
  routes/patientDashboard.routes.js        NEW  mounted under /patient
  routes/adminDashboard.routes.js          NEW  mounted under /admin
  routes/index.js                          EDIT three router mounts
  utils/serializers.js                     EDIT four serializers
  utils/period.js                          NEW  IST period resolution + zero-fill
  config/swagger.js                        EDIT eight endpoints
```

---

## 2. Phase 1 — data correctness (blocks everything downstream)

### 2.1 Extract the split into one helper

Today the 85/15 split is computed in exactly one place (`payment.service.confirmPaid`) and *forgotten* in the other (`booking.service.markPaid`). That's not a typo, it's the predictable outcome of the rule not having a home. Give it one.

In `services/payment.service.js`, above `confirmPaid`:

```js
/**
 * Stamp the platform/doctor split onto a payment that is about to become
 * `success`. The ONLY place the commission rate is applied — both the online
 * (confirmPaid) and offline (booking.service.markPaid) confirm paths call this,
 * so they cannot drift again. Mutates in place; the caller saves.
 *
 * The split is stored, never re-derived at read time: a future change to
 * PLATFORM_COMMISSION_PCT must not retroactively rewrite historical rows
 * (README §3, rule 3).
 */
function applySplit(payment) {
  const commission = round2(Number(payment.amount) * PLATFORM_COMMISSION_PCT);
  payment.commissionAmount = commission;
  payment.doctorPayoutAmount = round2(Number(payment.amount) - commission);
}
```

`confirmPaid` loses its two inline assignments and calls `applySplit(payment)`. Export it alongside the rest.

### 2.2 Fix `markPaid`

`services/booking.service.js` — the offline confirm path. It currently sets `status` and `paidAt` and stops:

```js
// before
payment.status = PAYMENT_STATUS.SUCCESS;
payment.paidAt = new Date();
await payment.save();

// after
payment.status = PAYMENT_STATUS.SUCCESS;
payment.paidAt = new Date();
paymentService.applySplit(payment);   // ← the bug fix
await payment.save();
```

`booking.service` does not currently import `payment.service`. It's a clean dependency direction (booking → payment, not the reverse) and introduces no cycle: `payment.service` imports models and `config`, never `booking.service`.

> **Why not compute the split in a Sequelize `beforeSave` hook?** Because it would fire on every save of every payment, including the `initiated` row created at booking time, and would need a `status === 'success'` guard that is itself the business rule — now hidden in a lifecycle hook where no one reads it. An explicit call at each of the two confirm sites is the honest expression of "confirming a payment stamps the split."

### 2.3 Migration `007_earnings_indexes.sql`

Forward-only, idempotent, tracked in `_migrations` — same discipline as `001`–`006`.

```sql
-- 007: Indexes for the dashboard/earnings aggregates + refund bookkeeping.
--
-- Also BACKFILLS the commission split on offline payments that were confirmed
-- through booking.service.markPaid() before it learned to call applySplit().
-- Those rows sit at status='success' with commission_amount = 0.00 and
-- doctor_payout_amount = 0.00 (the column defaults), which would make every
-- clinic consult worth ₹0 to both the doctor and the platform forever.

-- ── Refund bookkeeping (README §4.3) ────────────────────────────────────────
-- Without these, flipping a row to 'refunded' erases it from every
-- status='success' aggregate, silently mutating months already reported.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS refunded_at   DATETIME       NULL AFTER paid_at,
  ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10,2)  NOT NULL DEFAULT 0.00 AFTER refunded_at;

-- ── Aggregate indexes (README §4.2) ─────────────────────────────────────────
-- Every money query is `status='success' AND paid_at IN <range>`; leading with
-- the low-cardinality status then range-scanning paid_at is exactly the access
-- pattern. `005` gave us status alone, which degenerates to a full scan.
CREATE INDEX idx_payment_status_paid_at ON payments (status, paid_at);

-- Doctor tiles filter (doctor_id, status) then range on slot_date. `005`'s
-- (doctor_id, slot_date) can't skip cancelled rows without a filesort.
CREATE INDEX idx_booking_doctor_status_date ON bookings (doctor_id, status, slot_date);

-- Admin "bookings this month" ranges on slot_date across all doctors.
CREATE INDEX idx_booking_status_date ON bookings (status, slot_date);

-- ── Backfill the offline split (Phase 1, README §4.1) ───────────────────────
-- Scoped hard: only success rows whose split was never written. Re-running is a
-- no-op because the WHERE no longer matches. 0.15 is PLATFORM_COMMISSION_PCT at
-- the time of writing — matching what confirmPaid() stamped on the online rows
-- these are being reconciled against.
UPDATE payments
   SET commission_amount    = ROUND(amount * 0.15, 2),
       doctor_payout_amount = ROUND(amount - ROUND(amount * 0.15, 2), 2)
 WHERE status = 'success'
   AND mode = 'offline'
   AND commission_amount = 0.00
   AND doctor_payout_amount = 0.00
   AND amount > 0;
```

> **`CREATE INDEX` is not idempotent in MySQL 8** (no `IF NOT EXISTS` for indexes). The migration runner tracks applied files in `_migrations`, so `007` runs once — but if you re-run it by hand after a partial failure it will error on the first index. Either drop-then-create, or check `information_schema.STATISTICS` first. Match whatever `003`/`005` already do here; don't invent a third convention.

> **The backfill hardcodes `0.15`.** It has to: it's reconstructing what the *online* path stamped on contemporaneous rows, and importing a constant that may later change would make the migration produce different results depending on when it's run. A migration must be a pure function of the database. Leave the literal, keep the comment.

### 2.4 Model + constants

`models/payment.model.js` gains the two columns (`refundedAt: DATE, allowNull: true`, `refundAmount: DECIMAL(10,2), defaultValue: 0`). Note this model has `timestamps: false` — don't let `refundedAt` get mistaken for a Sequelize-managed field.

`config/constants.js` gains:

```js
/** Buckets a series may be grouped by. `day` is capped at DASHBOARD_MAX_DAYS. */
const SERIES_GRANULARITY = Object.freeze(["day", "month"]);
/** IST. Aggregates bucket by fixed offset, never the named zone (README §9). */
const IST_OFFSET = "+05:30";
const DASHBOARD_DEFAULT_MONTHS = 6;
const DASHBOARD_MAX_DAYS = 92;          // a `day` series wider than a quarter is a report, not a chart
const LEDGER_PAGE_SIZE_DEFAULT = 20;
const LEDGER_PAGE_SIZE_MAX = 100;
const ADMIN_TOP_DOCTORS_LIMIT = 5;
```

No string-literal enums anywhere downstream (convention rule 8).

---

## 3. `utils/period.js` — one place that knows what "this month" means

Three services need "resolve `from`/`to` into an IST-bounded UTC range" and "zero-fill the gaps in a sparse `GROUP BY` result." Written once.

```js
/**
 * Period math for the dashboards. Everything the user calls "today" or "this
 * month" is an Asia/Kolkata boundary; everything in the DB is UTC. This module
 * is the ONLY place that conversion lives.
 */

/** Current IST calendar date as 'YYYY-MM-DD' — what `slot_date = today` means. */
function istToday() { /* … */ }

/** Start (inclusive) + end (exclusive) UTC instants of the current IST month. */
function istMonthBounds(now = new Date()) { /* … */ }

/**
 * Resolve a validated {from, to} (or nothing) into a concrete UTC half-open
 * range [from, to). Defaults to the trailing DASHBOARD_DEFAULT_MONTHS.
 * Half-open, always: `paid_at < to` never double-counts the boundary instant
 * the way `BETWEEN` does.
 */
function resolveRange({ from, to, granularity }) { /* … */ }

/**
 * Fill the holes in a sparse aggregate. SQL returns only buckets that HAVE
 * rows; a chart needs a point for every bucket in the range — a month with no
 * consults is a ₹0 bar, not a missing bar that silently shortens the axis.
 *
 * Zero-filling in JS, not SQL: MySQL has no generate_series, and the recursive
 * CTE that emulates it is slower and far harder to read than a loop over a
 * Map keyed by bucket.
 */
function zeroFill(rows, { from, to, granularity, shape }) { /* … */ }
```

`resolveRange` is also where the `DASHBOARD_MAX_DAYS` guard lives: a `day` granularity over three years is 1,095 points nobody can read and a payload nobody needs. It throws `ApiError.badRequest` — a validator can't catch it because the constraint is on the *combination* of `from`, `to` and `granularity`.

---

## 4. `services/earnings.service.js` — the money aggregates

All business logic and all DB access. One `GROUP BY` per series; the two doctor-facing reads are scoped by `doctorId`, which the route guarantees is the caller's own (§6).

### 4.1 The one query shape

Every money aggregate is this, with the `SELECT` list and `GROUP BY` varying:

```js
/**
 * Bucket the doctor's successful payments by IST month (or day).
 *
 * Bucketing rules (README §3): money is bucketed by `paid_at`, never by
 * booking.created_at or slot_date; only status='success' is money.
 *
 * CONVERT_TZ with a FIXED OFFSET, not the named zone 'Asia/Kolkata': the named
 * zone returns NULL on any MySQL whose `mysql.time_zone*` tables were never
 * populated, and a NULL bucket key silently collapses a whole month into a
 * phantom row. The offset form needs no tz tables.
 */
const bucketExpr = (granularity) =>
  granularity === "day"
    ? `DATE(CONVERT_TZ(p.paid_at, '+00:00', '${IST_OFFSET}'))`
    : `DATE_FORMAT(CONVERT_TZ(p.paid_at, '+00:00', '${IST_OFFSET}'), '%Y-%m')`;

async function doctorSeries(doctorId, { from, to, granularity }) {
  const rows = await sequelize.query(
    `SELECT ${bucketExpr(granularity)}      AS bucket,
            SUM(p.amount)                   AS gross,
            SUM(p.commission_amount)        AS commission,
            SUM(p.doctor_payout_amount)     AS net,
            COUNT(*)                        AS consults
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id = :doctorId
        AND p.status    = :success
        AND p.paid_at  >= :from
        AND p.paid_at   < :to
      GROUP BY bucket
      ORDER BY bucket`,
    { replacements: { doctorId, success: PAYMENT_STATUS.SUCCESS, from, to }, type: QueryTypes.SELECT }
  );
  return zeroFill(rows, { from, to, granularity, shape: { gross: 0, commission: 0, net: 0, consults: 0 } });
}
```

Three things to notice, because each is a trap:

- **`granularity` is interpolated into the SQL string, `doctorId` is not.** `granularity` is Joi-restricted to the frozen `SERIES_GRANULARITY` list before it reaches here, so it's one of two known literals — but it is interpolated because a bind parameter cannot appear inside `DATE_FORMAT`'s format position. **Every other value is a `:replacement`.** If you later let a caller name the bucket column, you have written an injection.
- **`DECIMAL` comes back as a string.** `mysql2` returns `SUM(...)` over `DECIMAL(10,2)` as `"12345.00"`, not `12345`. `"1000" + "2000" === "10002000"`. Cast once, in the serializer (§7), and never again.
- **`SUM()` over zero rows is `NULL`, not `0`.** A doctor with no payments in range gets no row at all here (the `GROUP BY` emits nothing), which `zeroFill` handles — but the *summary* query in §4.2 has no `GROUP BY` and **will** return one row of `NULL`s. Coalesce it.

### 4.2 The rest of the surface

```js
/** Period totals — the Earnings page's tiles. One row, possibly all NULLs. */
async function doctorSummary(doctorId, range) { /* SELECT SUM(...) with no GROUP BY, COALESCE'd to 0 */ }

/** Cash owed to the doctor by patients at the clinic. NOT platform money. */
async function doctorAwaitingCollection(doctorId) { /* SUM(amount) WHERE status='pending_at_clinic' */ }

/** The paginated per-consult ledger a doctor reconciles a total against. */
async function doctorTransactions(doctorId, { from, to, page, limit }) {
  // findAndCountAll on Payment, include Booking → { patient (User), clinic },
  // order by paid_at DESC, offset/limit. ONE query for rows + one for the count.
  // The patient's name arrives through the `include` — never a findByPk per row
  // (convention rule 3).
}

/** Platform-wide money, same shape, no doctor scope. */
async function platformSummary(range) { /* … */ }
async function platformSeries(range) { /* … */ }

/**
 * Top N doctors by net payout. TWO queries, never N+1: one GROUP BY to rank the
 * ids, then ONE `WHERE user_id IN (:ids)` to hydrate names. Re-sort in JS to
 * preserve rank order, because `IN` does not preserve it.
 */
async function topDoctors(range, limit) { /* … */ }
```

`doctorTransactions` uses `findAndCountAll` with an `include`, not raw SQL — it returns whole rows with relations, which is exactly what the ORM is good at. The aggregates use `sequelize.query` because expressing `SUM(...) GROUP BY DATE_FORMAT(CONVERT_TZ(...))` through the ORM's `fn`/`col`/`literal` soup is strictly less readable than the SQL it compiles to. Use the tool that makes the intent legible.

---

## 5. `services/dashboard.service.js` — the tiles

Counts, not money — except where it delegates to `earnings.service` rather than re-deriving a sum. The doctor's "Earned this month" tile is `earningsService.doctorSummary(doctorId, istMonthBounds())`, not a fourth copy of the same `SUM`.

```js
/** Patient tiles (README §5.1). Replaces the client-side .filter() reduction. */
async function patientSummary(patientId) {
  // ONE grouped count query over bookings (status → count), ONE sum over
  // payments, ONE findOne for the next appointment. Three queries, flat.
  //
  // Deliberately NOT `findAll()` + reduce in JS: that's what the frontend does
  // today, and it's why the tiles will start lying the day GET /patient/bookings
  // grows a `?page=` (docs/doctor-discovery-sql left the same trap in the admin
  // and bookings lists).
}

/** Doctor tiles (README §5.2). `averageRating` is hardcoded null — see below. */
async function doctorSummary(doctorId) {
  const { start, end } = istMonthBounds();
  const [counts, earnings] = await Promise.all([ /* grouped counts */, earningsService.doctorSummary(doctorId, { from: start, to: end }) ]);
  return {
    todaysAppointments: /* … */,
    patientsThisMonth: /* COUNT(DISTINCT patient_id) */,
    averageRating: null,   // no `reviews` table exists (dbstruct §17 is unmigrated).
                           // null, never 0 — 0 renders as a 0-star doctor.
    earnedThisMonth: earnings.net,
  };
}

/** Admin tiles (README §5.4). */
async function adminSummary(range) { /* doctor counts by verification_status + platformSummary */ }
```

**`averageRating: null` is load-bearing.** Return `0` and the frontend renders a doctor with a zero-star rating; return `null` and it renders `—`. The field exists in the contract from day one so that the reviews plan fills it in without a shape change.

The doctor's status counts come from **one** `GROUP BY status` query, then a lookup in JS — not four `COUNT(*)` round-trips:

```js
const rows = await Booking.findAll({
  attributes: ["status", [fn("COUNT", col("id")), "n"]],
  where: { doctorId, slotDate: { [Op.gte]: monthStart, [Op.lt]: monthEnd } },
  group: ["status"],
  raw: true,
});
const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
```

---

## 6. Validators, controllers, routes

### 6.1 `validators/dashboard.validator.js`

The only place query shape is checked (convention rule 1). Every endpoint here is a `GET` with query params, so they all go through the existing **`middlewares/validateQuery.js`**, not `validate()`.

> **Use `validateQuery`, never `validate(schema, "query")`.** `validate()` finishes by reassigning `req[property]`, and in Express 5 `req.query` is a lazy getter with **no setter** — the assignment throws. `validateQuery` validates identically (`abortEarly:false`, `stripUnknown`, `convert`) but publishes the coerced result on **`req.validatedQuery`**, leaving `req.query` alone. It already exists and `GET /doctors` already uses it; `doctorPrescription.routes.js:61` carries a comment explaining the same trap. Controllers read `req.validatedQuery`.

`stripUnknown` means a stray `?doctorId=99` on a doctor route is *deleted*, not honoured.

```js
const period = {
  from: Joi.date().iso().optional(),
  to:   Joi.date().iso().optional().greater(Joi.ref("from")),   // rejects an inverted range
  granularity: Joi.string().valid(...SERIES_GRANULARITY).default("month"),
};

module.exports = {
  series:       Joi.object({ ...period }),
  summary:      Joi.object({ from: period.from, to: period.to }),
  transactions: Joi.object({
    ...period,
    page:  Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(LEDGER_PAGE_SIZE_MAX).default(LEDGER_PAGE_SIZE_DEFAULT),
  }),
  topDoctors:   Joi.object({ ...period, limit: Joi.number().integer().min(1).max(20).default(ADMIN_TOP_DOCTORS_LIMIT) }),
};
```

`.greater(Joi.ref("from"))` catches `?from=2026-07-01&to=2026-01-01` at the edge, where it belongs. Without it the query runs, returns nothing, and the chart renders an empty axis that looks like "no earnings."

### 6.2 Controllers — thin

Read validated input, call exactly one service function, serialize, respond. No `if`, no `try/catch`, no `Model.` (convention rule 2).

```js
exports.earningsSeries = asyncHandler(async (req, res) => {
  const range = resolveRange(req.validatedQuery);   // never req.query — see §6.1
  const data = await earningsService.doctorSeries(req.doctorId, range);
  return ok(res, serializeEarningsSeries(data), "Earnings series");
});
```

`req.doctorId` is set by `resolveDoctorId('self')`. The controller never reads `req.user.id` and never accepts a doctor id from the client.

### 6.3 Routes

```js
// routes/doctorDashboard.routes.js — mounted under /doctor in routes/index.js
const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router.get("/dashboard/summary",      ...guard, dashboard.doctorSummary);
router.get("/earnings/summary",       ...guard, validateQuery(schema.summary),      earnings.summary);
router.get("/earnings/series",        ...guard, validateQuery(schema.series),       earnings.series);
router.get("/earnings/transactions",  ...guard, validateQuery(schema.transactions), earnings.transactions);
```

The guard chain is the authorization. `resolveDoctorId('self')` pins `req.doctorId` to the authenticated user, so **there is no code path by which a doctor aggregates another doctor's payments** — it isn't a `where` clause a future refactor can drop, it's the only id the controller can see. Patient routes mount under `/patient` with `authorize('patient')` and scope on `req.user.id`; admin routes under `/admin` with `authorize('admin')` and no scope, which is the point.

Three one-line mounts in `routes/index.js`, alongside the existing `/doctor` routers.

---

## 7. Serializers

Raw rows never reach `res.json` (convention rule 5). This is also the **one** place `DECIMAL`-as-string becomes a number.

```js
/**
 * mysql2 hands DECIMAL back as a string ("1234.50"), and SUM() over zero rows
 * hands back NULL. Both become a real number exactly once, here — so no
 * component ever does `"1000" + "2000"` and renders ₹10002000.
 */
const money = (v) => (v == null ? 0 : Math.round(Number(v) * 100) / 100);

function serializeEarningsSummary(r) {
  return {
    gross: money(r.gross), commission: money(r.commission), net: money(r.net),
    refunded: money(r.refunded), consults: Number(r.consults ?? 0),
    // null, not NaN, not 0 — "no consults" is not "₹0 average"
    averagePerConsult: r.consults > 0 ? money(r.net / r.consults) : null,
    awaitingCollection: money(r.awaitingCollection),
  };
}

function serializeEarningsBucket(b)  { /* { bucket, gross, commission, net, consults } */ }
function serializeLedgerRow(p)       { /* { id, paidAt, patientName, mode, gross, commission, net } */ }
function serializeAdminSummary(s)    { /* { verifiedDoctors, pendingVerifications, bookingsThisMonth,
                                            platformRevenue, gmv, doctorPayouts } */ }
```

`averagePerConsult` returning `null` at zero consults, rather than `NaN` (from `0/0`) or a misleading `0`, is the same discipline as `averageRating: null`. `NaN` serializes to JSON as `null` anyway — but only by accident, and `JSON.stringify(NaN)` producing `null` is not a contract worth relying on.

---

## 8. Swagger

Eight endpoints into `config/swagger.js` under a new `Dashboards` tag (convention rule 10). Each documents the `from`/`to`/`granularity` query params, the `{ success, message, data }` envelope, and the `401`/`403` responses the guard chain produces. A route with no doc entry is incomplete.

---

## 9. Verification

Not "the tests pass" — the numbers reconcile.

1. **The split fix.** Seed one offline booking. `POST /doctor/bookings/:id/mark-paid`. Read the row: `commission_amount + doctor_payout_amount === amount`, and `commission_amount === round2(amount * 0.15)`. Before the fix, both are `0.00`.
2. **The backfill.** Against a database with pre-fix offline rows, run `npm run migrate`, then assert **zero** rows match `status='success' AND amount > 0 AND doctor_payout_amount = 0.00`.
3. **Ledger reconciles to summary.** For a fixed range, `GET /doctor/earnings/summary` `.net` must equal the sum of `.net` across **every page** of `GET /doctor/earnings/transactions`. This is the single most valuable assertion in the plan: it catches timezone-boundary bugs, `BETWEEN`-vs-half-open double counting, and status-filter drift in one shot.
4. **Series sums to summary.** `sum(series[].net) === summary.net` over the same range.
5. **Timezone boundary.** A payment with `paid_at = 2026-07-31T19:00:00Z` is **2026-08-01 00:30 IST** → it belongs to the *August* bucket. Assert it. This is the bug the fixed-offset `CONVERT_TZ` exists to prevent, and the one a naive `DATE(paid_at)` gets wrong every single month.
6. **Isolation.** Doctor A's token against `/doctor/earnings/summary` never returns a rupee of Doctor B's, including with `?doctorId=B` appended (`stripUnknown` must drop it).
7. **Empty state.** A brand-new doctor gets `net: 0`, `consults: 0`, `averagePerConsult: null`, and a zero-filled series of the right length — not `NaN`, not `null` totals, not a zero-length array.
8. **No N+1.** Run the ledger and `topDoctors` with Sequelize query logging on. Ledger = 2 queries regardless of page size. `topDoctors` = 2 queries regardless of `limit`.
