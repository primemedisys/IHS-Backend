/**
 * Money aggregates for the doctor's Earnings module and the admin's revenue
 * overview (docs/dashboards-earnings/backend-plan.md §4).
 *
 * Three rules govern every query here (README §3):
 *   1. Only `payments.status = 'success'` is money. `initiated` is an abandoned
 *      checkout, `pending_at_clinic` is cash the patient hasn't handed over.
 *   2. Money is bucketed by `payments.paid_at` — never by booking.created_at
 *      (when the slot was held) or slot_date (when the consult happens).
 *   3. The commission split is READ from the stored columns, never re-derived.
 *      Multiplying by today's PLATFORM_COMMISSION_PCT would rewrite history the
 *      day the rate changes.
 *
 * Every series is ONE `GROUP BY`; the ledger is `findAndCountAll` with an
 * include. No query ever runs inside a loop.
 */
const { QueryTypes, Op } = require("sequelize");
const { sequelize, Payment, Booking, DoctorProfile, User } = require("../models");
const { zeroFill } = require("../utils/period");
const { PAYMENT_STATUS, IST_OFFSET } = require("../config/constants");

/** The zero row for an empty bucket — shape must match the SELECT list. */
const EMPTY_BUCKET = { gross: 0, commission: 0, net: 0, consults: 0 };

/**
 * The IST bucket expression.
 *
 * `granularity` is interpolated into the SQL string because a bind parameter
 * cannot appear inside DATE_FORMAT's format position. It is safe ONLY because
 * Joi has already restricted it to the frozen SERIES_GRANULARITY list before it
 * reaches this module — it is one of exactly two known literals. Every other
 * value below is a `:replacement`. If you ever let a caller name a column here,
 * you have written an injection.
 *
 * CONVERT_TZ uses a FIXED OFFSET, not the named zone 'Asia/Kolkata': the named
 * form returns NULL on any MySQL whose `mysql.time_zone*` tables were never
 * populated, and a NULL bucket key silently collapses a month into a phantom row.
 */
const bucketExpr = (granularity, column = "p.paid_at") =>
  granularity === "day"
    ? `DATE_FORMAT(CONVERT_TZ(${column}, '+00:00', '${IST_OFFSET}'), '%Y-%m-%d')`
    : `DATE_FORMAT(CONVERT_TZ(${column}, '+00:00', '${IST_OFFSET}'), '%Y-%m')`;

/**
 * mysql2 hands DECIMAL back as a string ("1234.50"), and SUM() over zero rows
 * hands back NULL. Both become a real number exactly once — here — so nothing
 * downstream ever computes `"1000" + "2000" === "10002000"`.
 */
const money = (v) => (v == null ? 0 : Math.round(Number(v) * 100) / 100);
const count = (v) => (v == null ? 0 : Number(v));

/** Coerce a raw aggregate row into numbers. */
const numeric = (r) => ({
  bucket: r.bucket,
  gross: money(r.gross),
  commission: money(r.commission),
  net: money(r.net),
  consults: count(r.consults),
});

// ── Doctor ───────────────────────────────────────────────────────────────────

/**
 * Period totals — the Earnings page's tiles.
 *
 * No GROUP BY, so a doctor with no payments in range gets ONE row of NULLs
 * rather than zero rows. `money()` coalesces; do not "fix" this by adding
 * HAVING, which would remove the row and break the caller's destructuring.
 */
async function doctorSummary(doctorId, { from, to }) {
  const [totals] = await sequelize.query(
    `SELECT SUM(p.amount)               AS gross,
            SUM(p.commission_amount)    AS commission,
            SUM(p.doctor_payout_amount) AS net,
            COUNT(*)                    AS consults
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id = :doctorId
        AND p.status    = :success
        AND p.paid_at  >= :from
        AND p.paid_at   < :to`,
    {
      replacements: { doctorId, success: PAYMENT_STATUS.SUCCESS, from, to },
      type: QueryTypes.SELECT,
    }
  );

  // Refunds are bucketed by refunded_at, not paid_at: a July payment refunded in
  // August must leave July's gross intact and land in August's `refunded`.
  const [refunds] = await sequelize.query(
    `SELECT SUM(p.refund_amount) AS refunded
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id   = :doctorId
        AND p.status      = :refunded
        AND p.refunded_at >= :from
        AND p.refunded_at  < :to`,
    {
      replacements: { doctorId, refunded: PAYMENT_STATUS.REFUNDED, from, to },
      type: QueryTypes.SELECT,
    }
  );

  const consults = count(totals?.consults);
  const net = money(totals?.net);

  return {
    gross: money(totals?.gross),
    commission: money(totals?.commission),
    net,
    refunded: money(refunds?.refunded),
    consults,
    // null, not NaN (0/0) and not a misleading 0 — "no consults" is not "₹0 average".
    averagePerConsult: consults > 0 ? money(net / consults) : null,
    awaitingCollection: await doctorAwaitingCollection(doctorId),
  };
}

/**
 * Cash owed to the doctor BY PATIENTS, at the clinic. Not a platform payout and
 * not earnings — it is deliberately excluded from gross/net/consults, and the
 * UI labels it as such. There is no `payouts` table; the platform does not yet
 * record what it owes a doctor.
 */
async function doctorAwaitingCollection(doctorId) {
  const [row] = await sequelize.query(
    `SELECT SUM(p.amount) AS pending
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id = :doctorId AND p.status = :pending`,
    {
      replacements: { doctorId, pending: PAYMENT_STATUS.PENDING_AT_CLINIC },
      type: QueryTypes.SELECT,
    }
  );
  return money(row?.pending);
}

/** Bucket the doctor's successful payments by IST month (or day). */
async function doctorSeries(doctorId, { from, to, granularity }) {
  const rows = await sequelize.query(
    `SELECT ${bucketExpr(granularity)}  AS bucket,
            SUM(p.amount)               AS gross,
            SUM(p.commission_amount)    AS commission,
            SUM(p.doctor_payout_amount) AS net,
            COUNT(*)                    AS consults
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id = :doctorId
        AND p.status    = :success
        AND p.paid_at  >= :from
        AND p.paid_at   < :to
      GROUP BY bucket
      ORDER BY bucket`,
    {
      replacements: { doctorId, success: PAYMENT_STATUS.SUCCESS, from, to },
      type: QueryTypes.SELECT,
    }
  );
  return zeroFill(rows.map(numeric), { from, to, granularity, shape: EMPTY_BUCKET });
}

/**
 * The paginated per-consult ledger a doctor reconciles a total against.
 *
 * `findAndCountAll` + `include` (not raw SQL): this returns whole rows with a
 * relation, which is what the ORM is good at. The patient's name arrives through
 * the include — never a findByPk per row.
 */
async function doctorTransactions(doctorId, { from, to, page, limit }) {
  const { rows, count: total } = await Payment.findAndCountAll({
    where: {
      status: PAYMENT_STATUS.SUCCESS,
      paidAt: { [Op.gte]: from, [Op.lt]: to },
    },
    include: [
      {
        model: Booking,
        as: "booking",
        required: true,
        where: { doctorId },
        attributes: ["id", "bookingType", "slotDate"],
        include: [{ model: User, as: "patient", attributes: ["id", "name"] }],
      },
    ],
    order: [["paidAt", "DESC"]],
    offset: (page - 1) * limit,
    limit,
  });

  return {
    rows,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ── Admin (platform-wide; no doctor scope) ───────────────────────────────────

/** Platform money for a period: commission is income, gmv is total transacted. */
async function platformSummary({ from, to }) {
  const [row] = await sequelize.query(
    `SELECT SUM(amount)               AS gmv,
            SUM(commission_amount)    AS commission,
            SUM(doctor_payout_amount) AS payouts,
            COUNT(*)                  AS payments
       FROM payments
      WHERE status = :success AND paid_at >= :from AND paid_at < :to`,
    { replacements: { success: PAYMENT_STATUS.SUCCESS, from, to }, type: QueryTypes.SELECT }
  );
  return {
    gmv: money(row?.gmv),
    platformRevenue: money(row?.commission),
    doctorPayouts: money(row?.payouts),
    payments: count(row?.payments),
  };
}

/** Platform revenue bucketed by IST month (or day), with booking volume. */
async function platformSeries({ from, to, granularity }) {
  const rows = await sequelize.query(
    `SELECT ${bucketExpr(granularity, "paid_at")} AS bucket,
            SUM(amount)               AS gmv,
            SUM(commission_amount)    AS commission,
            SUM(doctor_payout_amount) AS payouts,
            COUNT(*)                  AS bookings
       FROM payments
      WHERE status = :success AND paid_at >= :from AND paid_at < :to
      GROUP BY bucket
      ORDER BY bucket`,
    { replacements: { success: PAYMENT_STATUS.SUCCESS, from, to }, type: QueryTypes.SELECT }
  );

  const shaped = rows.map((r) => ({
    bucket: r.bucket,
    gmv: money(r.gmv),
    commission: money(r.commission),
    payouts: money(r.payouts),
    bookings: count(r.bookings),
  }));

  return zeroFill(shaped, {
    from,
    to,
    granularity,
    shape: { gmv: 0, commission: 0, payouts: 0, bookings: 0 },
  });
}

/**
 * Top N doctors by net payout. TWO queries, never N+1: one GROUP BY to rank the
 * ids, then ONE `WHERE user_id IN (:ids)` to hydrate names. Re-sorted in JS
 * afterwards because `IN` does not preserve the ranked order.
 */
async function topDoctors({ from, to }, limit) {
  const ranked = await sequelize.query(
    `SELECT b.doctor_id                 AS doctorId,
            SUM(p.doctor_payout_amount) AS net,
            COUNT(*)                    AS consults
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = :success AND p.paid_at >= :from AND p.paid_at < :to
      GROUP BY b.doctor_id
      ORDER BY net DESC
      LIMIT :limit`,
    {
      replacements: { success: PAYMENT_STATUS.SUCCESS, from, to, limit },
      type: QueryTypes.SELECT,
    }
  );
  if (!ranked.length) return [];

  const ids = ranked.map((r) => r.doctorId);
  const profiles = await DoctorProfile.findAll({
    where: { userId: { [Op.in]: ids } },
    attributes: ["userId"],
    include: [{ model: User, as: "user", attributes: ["id", "name"] }],
  });
  const byId = new Map(profiles.map((p) => [String(p.userId), p]));

  return ranked.map((r) => ({
    doctorId: String(r.doctorId),
    name: byId.get(String(r.doctorId))?.user?.name ?? "Unknown doctor",
    net: money(r.net),
    consults: count(r.consults),
  }));
}

module.exports = {
  doctorSummary,
  doctorAwaitingCollection,
  doctorSeries,
  doctorTransactions,
  platformSummary,
  platformSeries,
  topDoctors,
  money,
  count,
};
