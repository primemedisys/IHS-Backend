/**
 * Doctor Dashboard 2.0 analytics (docs/doctor-dashboard-2-31-10-2026).
 *
 * Every number is ONE server-side aggregate over real rows, scoped by
 * `doctorId` in the WHERE clause (the route pins it to the signed-in doctor).
 * No query runs in a loop; tables are paginated in SQL.
 *
 * Shared definitions (METRICS.md has the full list):
 *  - Dates are IST calendar days (the project convention): `slot_date` for
 *    appointments, `paid_at` / `refunded_at` (converted to IST) for money.
 *  - "Treated" booking = confirmed or completed — the same patient rule as the
 *    existing overview and EMR workbench.
 *  - Abandoned checkouts (cancelled with reason hold_expired / order_failed) are
 *    never appointments or cancellations — the patient never finished booking.
 *  - A patient's FIRST VISIT with this doctor = their earliest treated booking.
 *    New patient in a period = first visit inside it; returning = seen in the
 *    period with a first visit before it.
 *  - Money follows earnings.service: only `success` payments are collected
 *    (a refunded payment's status is `refunded`, so it is never counted as
 *    retained), the commission split is read from the stored columns, and
 *    `pending_at_clinic` is outstanding cash, never revenue.
 *  - Metrics the platform does not record are returned as
 *    `{ available: false, reason }` — never as 0.
 */
const { QueryTypes, Op } = require("sequelize");
const {
  sequelize,
  Booking,
  Payment,
  User,
  Clinic,
  ClinicAvailability,
  DoctorOnlineAvailability,
  AvailabilityException,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { regNoOf } = require("../utils/patientRegNo");
const { istToday, istDateRangeBounds, addDays, zeroFill } = require("../utils/period");
const acquisition = require("./acquisition.service");
const {
  BOOKING_STATUS: BS,
  PAYMENT_STATUS: PS,
  OFFLINE_PAYMENT_METHOD,
  IST_OFFSET,
  ACQUISITION_GROUPS,
  PRESCRIPTION_STATUS,
} = require("../config/constants");

const TREATED = [BS.CONFIRMED, BS.COMPLETED];
/** SQL fragment: this booking was a real appointment (not an abandoned checkout). */
const REAL = `NOT (b.status = 'cancelled' AND COALESCE(b.cancelled_reason, '') IN ('hold_expired','order_failed'))`;
/** SQL fragment: cancelled by a person (patient / doctor), not an expired hold. */
const PERSON_CANCELLED = `(b.status = 'cancelled' AND COALESCE(b.cancelled_reason, '') NOT IN ('hold_expired','order_failed'))`;

const ACTIVE_WINDOW_DAYS = 90;
const ON_TIME_MINUTES = 15;
const MAX_CONSULT_SECONDS = 4 * 60 * 60; // ignore a consult left "open" for hours
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

const money = (v) => (v == null ? 0 : Math.round(Number(v) * 100) / 100);
const count = (v) => (v == null ? 0 : Number(v));
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const avg = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
/** Change vs the previous period, in %; null when there is nothing to compare with. */
const growth = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const unavailable = (reason) => ({ available: false, reason });

async function q(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

// ── Ranges ──────────────────────────────────────────────────────────────────
/**
 * A validated IST day range (inclusive) → everything a query needs. Default =
 * this month to date. `prev` is the equally long span right before it.
 */
function resolvePeriod({ from, to } = {}) {
  const today = istToday();
  const toDay = to || today;
  const fromDay = from || `${today.slice(0, 7)}-01`;
  if (fromDay > toDay) throw ApiError.badRequest("`from` must be on or before `to`");
  const days = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw ApiError.badRequest(`A range can cover at most ${MAX_RANGE_DAYS} days`);
  const prevTo = addDays(fromDay, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const cur = istDateRangeBounds(fromDay, toDay);
  const prev = istDateRangeBounds(prevFrom, prevTo);
  return { today, fromDay, toDay, days, prevFrom, prevTo, fromTs: cur.from, toTs: cur.to, prevFromTs: prev.from, prevToTs: prev.to };
}

/** Granularity checks: a day series is capped at 92 points. */
function seriesGranularity(period, granularity) {
  const g = granularity || (period.days <= 31 ? "day" : period.days <= 120 ? "week" : "month");
  if (g === "day" && period.days > 92) throw ApiError.badRequest("A daily series is capped at 92 days — use week or month");
  return g;
}

/** SQL bucket key for a DATE column (sortable strings that match utils/period keys). */
function dateBucket(g, column) {
  if (g === "day") return `DATE_FORMAT(${column}, '%Y-%m-%d')`;
  if (g === "week") return `DATE_FORMAT(DATE_SUB(${column}, INTERVAL WEEKDAY(${column}) DAY), '%Y-%m-%d')`;
  return `DATE_FORMAT(${column}, '%Y-%m')`;
}
/** SQL bucket key for a UTC DATETIME column, in IST. Fixed offset (see earnings.service). */
function instantBucket(g, column) {
  return dateBucket(g, `DATE(CONVERT_TZ(${column}, '+00:00', '${IST_OFFSET}'))`);
}

/** Per-patient first treated visit with this doctor — a derived table. */
const FIRST_VISITS = `(SELECT patient_id, MIN(slot_date) AS first_date
                         FROM bookings WHERE doctor_id = :doctorId AND status IN (:treated)
                        GROUP BY patient_id)`;

// ── Patients ────────────────────────────────────────────────────────────────
async function patientKpis(doctorId, p) {
  const r = { doctorId, treated: TREATED, f: p.fromDay, t: p.toDay, pf: p.prevFrom, pt: p.prevTo, today: p.today };
  const [[base], [firsts], [seen], [today], [cancel]] = await Promise.all([
    q(
      `SELECT COUNT(DISTINCT CASE WHEN b.status IN (:treated) THEN b.patient_id END) AS total,
              COUNT(DISTINCT CASE WHEN b.status IN (:treated) AND b.slot_date >= :active THEN b.patient_id END) AS active
         FROM bookings b WHERE b.doctor_id = :doctorId`,
      { ...r, active: addDays(p.today, -(ACTIVE_WINDOW_DAYS - 1)) }
    ),
    q(
      `SELECT SUM(f.first_date BETWEEN :f AND :t) AS newCur, SUM(f.first_date BETWEEN :pf AND :pt) AS newPrev
         FROM ${FIRST_VISITS} f`,
      r
    ),
    q(
      `SELECT COUNT(DISTINCT b.patient_id) AS seen,
              COUNT(DISTINCT CASE WHEN f.first_date < :f THEN b.patient_id END) AS returning
         FROM bookings b JOIN ${FIRST_VISITS} f ON f.patient_id = b.patient_id
        WHERE b.doctor_id = :doctorId AND b.status IN (:treated) AND b.slot_date BETWEEN :f AND :t`,
      r
    ),
    q(
      `SELECT COUNT(DISTINCT CASE WHEN b.status IN ('confirmed','completed','no_show') THEN b.patient_id END) AS patients,
              COUNT(DISTINCT CASE WHEN b.status = 'completed' THEN b.patient_id END) AS completed,
              COUNT(DISTINCT CASE WHEN b.status = 'confirmed' THEN b.patient_id END) AS remaining
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.slot_date = :today`,
      r
    ),
    q(
      `SELECT SUM(${PERSON_CANCELLED}) AS cancelled,
              SUM(b.status <> 'pending_payment') AS eligible
         FROM bookings b
        WHERE b.doctor_id = :doctorId AND b.slot_date BETWEEN :f AND :t AND ${REAL}`,
      r
    ),
  ]);
  const seenN = count(seen?.seen);
  const returning = count(seen?.returning);
  const cancelled = count(cancel?.cancelled);
  const eligible = count(cancel?.eligible);
  return {
    total: count(base?.total),
    active: count(base?.active),
    activeWindowDays: ACTIVE_WINDOW_DAYS,
    new: count(firsts?.newCur),
    newPrevious: count(firsts?.newPrev),
    newGrowth: growth(count(firsts?.newCur), count(firsts?.newPrev)),
    seenInPeriod: seenN,
    returning,
    returningPercent: pct(returning, seenN),
    today: { patients: count(today?.patients), completed: count(today?.completed), remaining: count(today?.remaining) },
    cancellations: { count: cancelled, rate: pct(cancelled, eligible), eligible },
  };
}

// ── Appointments ────────────────────────────────────────────────────────────
async function appointmentKpis(doctorId, p) {
  const r = { doctorId, f: p.fromDay, t: p.toDay, today: p.today };
  const [rows, [todayRow], [upcoming], [next], [timing]] = await Promise.all([
    q(
      `SELECT b.status, b.booking_type AS type, COUNT(*) AS n, SUM(b.rescheduled_at IS NOT NULL) AS rescheduled,
              SUM(b.status = 'confirmed' AND b.slot_date < :today) AS overdueOpen
         FROM bookings b
        WHERE b.doctor_id = :doctorId AND b.slot_date BETWEEN :f AND :t AND ${REAL}
        GROUP BY b.status, b.booking_type`,
      r
    ),
    q(
      `SELECT SUM(b.status IN ('confirmed','completed','no_show')) AS total,
              SUM(b.status IN ('confirmed','completed','no_show') AND b.booking_type = 'offline') AS clinic,
              SUM(b.status IN ('confirmed','completed','no_show') AND b.booking_type = 'online') AS video,
              SUM(b.status = 'confirmed' AND b.queue_state = 'waiting') AS queued,
              SUM(b.status = 'confirmed' AND b.queue_state = 'serving') AS serving,
              SUM(b.status = 'pending_payment') AS awaitingPayment
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.slot_date = :today`,
      r
    ),
    q(
      `SELECT COUNT(*) AS n, SUM(b.status = 'pending_payment') AS awaitingPayment
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.slot_date > :today AND b.status IN ('confirmed','pending_payment')`,
      r
    ),
    q(
      `SELECT b.id, b.slot_date AS date, b.slot_start_time AS time, b.booking_type AS type, b.queue_number AS token, u.name AS patientName
         FROM bookings b JOIN users u ON u.id = b.patient_id
        WHERE b.doctor_id = :doctorId AND b.status = 'confirmed' AND b.slot_date > :today
        ORDER BY b.slot_date, b.slot_start_time, b.queue_number LIMIT 1`,
      r
    ),
    q(
      `SELECT AVG(TIMESTAMPDIFF(SECOND, b.consult_started_at, b.consult_ended_at)) / 60 AS avgMinutes, COUNT(*) AS measured
         FROM bookings b
        WHERE b.doctor_id = :doctorId AND b.status = 'completed' AND b.slot_date BETWEEN :f AND :t
          AND b.consult_started_at IS NOT NULL AND b.consult_ended_at > b.consult_started_at
          AND TIMESTAMPDIFF(SECOND, b.consult_started_at, b.consult_ended_at) <= ${MAX_CONSULT_SECONDS}`,
      r
    ),
  ]);

  const by = { total: 0, clinic: 0, video: 0, rescheduled: 0, overdueOpen: 0 };
  const status = { pending_payment: 0, confirmed: 0, completed: 0, cancelled: 0, no_show: 0 };
  const completedByType = { clinic: 0, video: 0 };
  for (const row of rows) {
    const n = count(row.n);
    by.total += n;
    by[row.type === "offline" ? "clinic" : "video"] += n;
    by.rescheduled += count(row.rescheduled);
    by.overdueOpen += count(row.overdueOpen);
    status[row.status] = (status[row.status] ?? 0) + n;
    if (row.status === BS.COMPLETED) completedByType[row.type === "offline" ? "clinic" : "video"] += n;
  }
  // Appointments that are OVER: completed, no-show, cancelled, or confirmed with a past date.
  const concluded = status.completed + status.no_show + status.cancelled + by.overdueOpen;
  return {
    period: {
      total: by.total,
      byStatus: status,
      clinic: by.clinic,
      video: by.video,
      clinicRate: pct(by.clinic, by.total),
      videoRate: pct(by.video, by.total),
      rescheduled: by.rescheduled,
      completed: status.completed,
      completedClinic: completedByType.clinic,
      completedVideo: completedByType.video,
      completionRate: pct(status.completed, concluded),
      noShow: status.no_show,
      noShowRate: pct(status.no_show, concluded),
      cancelled: status.cancelled,
      notMarkedComplete: by.overdueOpen,
    },
    today: {
      total: count(todayRow?.total),
      clinic: count(todayRow?.clinic),
      video: count(todayRow?.video),
      // In the token queue for today (booked, not yet called) — NOT proof the patient has arrived.
      queued: count(todayRow?.queued),
      serving: count(todayRow?.serving),
      awaitingPayment: count(todayRow?.awaitingPayment),
    },
    upcoming: {
      count: count(upcoming?.n),
      awaitingPayment: count(upcoming?.awaitingPayment),
      next: next
        ? { bookingId: String(next.id), date: String(next.date).slice(0, 10), time: next.time, mode: next.type === "online" ? "video" : "clinic", token: next.token, patientName: next.patientName }
        : null,
    },
    consultDuration: count(timing?.measured)
      ? { available: true, averageMinutes: avg(timing.avgMinutes), measured: count(timing.measured) }
      : unavailable("No consultation in this period has both a start and an end time recorded."),
    waitingTime: unavailable("Patient arrival / check-in time is not recorded, so waiting time can't be measured."),
  };
}

// ── Money ───────────────────────────────────────────────────────────────────
async function moneyTotals(doctorId, fromTs, toTs) {
  const r = { doctorId, success: PS.SUCCESS, refunded: PS.REFUNDED, fromTs, toTs };
  const [[collected], [refunds], [failed]] = await Promise.all([
    q(
      `SELECT SUM(p.amount) AS gross, SUM(p.commission_amount) AS commission, SUM(p.doctor_payout_amount) AS net, COUNT(*) AS n,
              SUM(CASE WHEN b.booking_type = 'offline' THEN p.amount END) AS clinic,
              SUM(CASE WHEN b.booking_type = 'online' THEN p.amount END) AS video,
              SUM(CASE WHEN p.mode = 'online' THEN p.amount END) AS online,
              SUM(CASE WHEN p.mode = 'offline' AND COALESCE(p.offline_method, 'cash') = 'cash' THEN p.amount END) AS cash,
              SUM(CASE WHEN p.mode = 'offline' AND p.offline_method = 'upi_qr' THEN p.amount END) AS upi,
              SUM(b.status = 'completed') AS completedPaid
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = :success AND p.paid_at >= :fromTs AND p.paid_at < :toTs`,
      r
    ),
    q(
      `SELECT SUM(p.refund_amount) AS amount, COUNT(*) AS n
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = :refunded AND p.refunded_at >= :fromTs AND p.refunded_at < :toTs`,
      r
    ),
    q(
      `SELECT COUNT(*) AS n FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = 'failed' AND p.created_at >= :fromTs AND p.created_at < :toTs`,
      r
    ),
  ]);
  const gross = money(collected?.gross);
  const completedPaid = count(collected?.completedPaid);
  return {
    collected: gross,
    commission: money(collected?.commission),
    doctorNet: money(collected?.net),
    transactions: count(collected?.n),
    consultation: { clinic: money(collected?.clinic), video: money(collected?.video), total: gross },
    methods: { online: money(collected?.online), cash: money(collected?.cash), upi: money(collected?.upi) },
    refunded: money(refunds?.amount),
    refundCount: count(refunds?.n),
    failedTransactions: count(failed?.n),
    averagePerCompletedConsult: completedPaid ? money(gross / completedPaid) : null,
  };
}

/** Cash / UPI owed at the clinic right now; overdue = the consult date has passed. */
async function outstanding(doctorId, today) {
  const [row] = await q(
    `SELECT SUM(p.amount) AS amount, COUNT(*) AS n,
            SUM(CASE WHEN b.slot_date < :today THEN p.amount END) AS overdueAmount,
            SUM(b.slot_date < :today) AS overdueCount
       FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE b.doctor_id = :doctorId AND p.status = :pending AND b.status IN ('confirmed','completed')`,
    { doctorId, today, pending: PS.PENDING_AT_CLINIC }
  );
  return {
    amount: money(row?.amount),
    count: count(row?.n),
    overdueAmount: money(row?.overdueAmount),
    overdueCount: count(row?.overdueCount),
  };
}

const NOT_RECORDED_REVENUE = unavailable(
  "IHS records consultation payments only — no procedure, surgery or contract billing exists yet."
);

async function financialKpis(doctorId, p) {
  const todayB = istDateRangeBounds(p.today, p.today);
  const weekStart = addDays(p.today, -6);
  const weekB = istDateRangeBounds(weekStart, p.today);
  const yearB = istDateRangeBounds(`${p.today.slice(0, 4)}-01-01`, p.today);
  const [cur, prev, pending, todayM, weekM, yearM] = await Promise.all([
    moneyTotals(doctorId, p.fromTs, p.toTs),
    moneyTotals(doctorId, p.prevFromTs, p.prevToTs),
    outstanding(doctorId, p.today),
    moneyTotals(doctorId, todayB.from, todayB.to),
    moneyTotals(doctorId, weekB.from, weekB.to),
    moneyTotals(doctorId, yearB.from, yearB.to),
  ]);
  return {
    period: cur,
    previous: { collected: prev.collected, doctorNet: prev.doctorNet },
    growth: growth(cur.collected, prev.collected),
    pending,
    today: todayM.collected,
    last7Days: weekM.collected,
    yearToDate: yearM.collected,
    procedureRevenue: NOT_RECORDED_REVENUE,
    surgeryRevenue: NOT_RECORDED_REVENUE,
    contractRevenue: NOT_RECORDED_REVENUE,
  };
}

// ── Quality ─────────────────────────────────────────────────────────────────
async function qualityKpis(doctorId, p) {
  const r = { doctorId, f: p.fromDay, t: p.toDay, today: p.today, finalized: PRESCRIPTION_STATUS.FINALIZED };
  const [[docs], [follow], [testimonials]] = await Promise.all([
    q(
      `SELECT COUNT(*) AS completed,
              SUM(EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.booking_id = b.id AND rx.status = :finalized)) AS withRx,
              SUM(EXISTS (SELECT 1 FROM clinical_notes cn WHERE cn.booking_id = b.id)) AS withNote
         FROM bookings b
        WHERE b.doctor_id = :doctorId AND b.status = 'completed' AND b.slot_date BETWEEN :f AND :t`,
      r
    ),
    q(
      `SELECT COUNT(*) AS scheduled,
              SUM(x.done) AS completed,
              SUM(NOT x.done AND x.follow_up_on >= :today) AS pending,
              SUM(NOT x.done AND x.follow_up_on < :today) AS overdue
         FROM (SELECT fu.follow_up_on,
                      EXISTS (SELECT 1 FROM bookings nb
                               WHERE nb.doctor_id = fu.doctor_id AND nb.patient_id = fu.patient_id
                                 AND nb.status = 'completed' AND nb.slot_date > src.slot_date) AS done
                 FROM patient_follow_ups fu JOIN bookings src ON src.id = fu.booking_id
                WHERE fu.doctor_id = :doctorId AND fu.follow_up_on BETWEEN :f AND :t) x`,
      r
    ),
    q(
      `SELECT COUNT(*) AS n, AVG(rating) AS avgRating FROM doctor_testimonials WHERE doctor_id = :doctorId AND is_visible = 1`,
      r
    ),
  ]);
  const completed = count(docs?.completed);
  const withRx = count(docs?.withRx);
  const fCompleted = count(follow?.completed);
  const fOverdue = count(follow?.overdue);
  return {
    satisfaction: {
      ...unavailable("IHS does not collect patient ratings or reviews yet."),
      // Shown for context only — these are testimonials the doctor added to their own profile.
      portfolioTestimonials: { count: count(testimonials?.n), averageRating: avg(testimonials?.avgRating) },
    },
    feedback: unavailable("IHS does not collect patient feedback yet."),
    documentation: {
      completedConsultations: completed,
      withFinalizedPrescription: withRx,
      withClinicalNote: count(docs?.withNote),
      missingPrescription: completed - withRx,
      rate: pct(withRx, completed),
    },
    followUp: {
      scheduled: count(follow?.scheduled),
      completed: fCompleted,
      pending: count(follow?.pending),
      overdue: fOverdue,
      // Of the follow-ups that are due (done or overdue), how many happened.
      rate: pct(fCompleted, fCompleted + fOverdue),
    },
  };
}

// ── Productivity ────────────────────────────────────────────────────────────
/** Weekly-schedule capacity per IST day over the range (current schedule; exceptions removed). */
async function scheduleCapacity(doctorId, p) {
  const [clinics, online, exceptions] = await Promise.all([
    ClinicAvailability.findAll({
      where: { isActive: true },
      include: [{ model: Clinic, as: "clinic", where: { doctorId, isActive: true }, attributes: ["id"], required: true }],
      attributes: ["clinicId", "dayOfWeek", "startTime", "endTime", "slotDurationMinutes", "maxBookings"],
    }),
    DoctorOnlineAvailability.findAll({
      where: { doctorId, isActive: true },
      attributes: ["dayOfWeek", "startTime", "endTime", "slotDurationMinutes", "maxBookings"],
    }),
    AvailabilityException.findAll({
      where: { doctorId, exceptionDate: { [Op.between]: [p.fromDay, p.toDay] } },
      attributes: ["clinicId", "exceptionDate"],
    }),
  ]);
  const minutes = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  };
  const cap = (w) =>
    w.maxBookings != null ? Number(w.maxBookings) : Math.max(0, Math.floor((minutes(w.endTime) - minutes(w.startTime)) / (w.slotDurationMinutes || 15)));
  const blocked = new Set(exceptions.map((e) => `${String(e.exceptionDate).slice(0, 10)}|${e.clinicId ?? "online"}`));
  let total = 0;
  for (let d = p.fromDay; d <= p.toDay; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    for (const w of clinics) if (w.dayOfWeek === dow && !blocked.has(`${d}|${w.clinicId}`)) total += cap(w);
    for (const w of online) if (w.dayOfWeek === dow && !blocked.has(`${d}|online`)) total += cap(w);
  }
  return total;
}

async function productivityKpis(doctorId, p) {
  const r = { doctorId, f: p.fromDay, t: p.toDay };
  const [[work], [booked], [sessions], capacity] = await Promise.all([
    q(
      `SELECT COUNT(*) AS consults, COUNT(DISTINCT b.slot_date) AS workingDays,
              SUM(b.booking_type = 'offline') AS opd, SUM(b.booking_type = 'online') AS video,
              COUNT(DISTINCT CONCAT(b.slot_date, '|', b.patient_id)) AS patientDays
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.status = 'completed' AND b.slot_date BETWEEN :f AND :t`,
      r
    ),
    q(
      `SELECT COUNT(*) AS n FROM bookings b
        WHERE b.doctor_id = :doctorId AND b.slot_date BETWEEN :f AND :t AND b.status IN ('confirmed','completed','no_show')`,
      r
    ),
    q(
      `SELECT COUNT(*) AS started,
              SUM(TIMESTAMPDIFF(MINUTE, TIMESTAMP(s.session_date, s.start_time),
                                CONVERT_TZ(s.started_at, '+00:00', '${IST_OFFSET}')) <= ${ON_TIME_MINUTES}) AS onTime,
              AVG(GREATEST(0, TIMESTAMPDIFF(MINUTE, TIMESTAMP(s.session_date, s.start_time),
                                CONVERT_TZ(s.started_at, '+00:00', '${IST_OFFSET}')))) AS avgDelay
         FROM consultation_sessions s
        WHERE s.doctor_id = :doctorId AND s.session_date BETWEEN :f AND :t AND s.started_at IS NOT NULL`,
      r
    ),
    scheduleCapacity(doctorId, p),
  ]);
  const consults = count(work?.consults);
  const days = count(work?.workingDays);
  const started = count(sessions?.started);
  const bookedN = count(booked?.n);
  return {
    consultations: consults,
    workingDays: days,
    consultationsPerDay: days ? avg(consults / days) : null,
    patientsPerDay: days ? avg(count(work?.patientDays) / days) : null,
    opd: count(work?.opd),
    video: count(work?.video),
    scheduleAdherence: started
      ? { available: true, onTime: count(sessions?.onTime), sessions: started, rate: pct(count(sessions?.onTime), started), averageStartDelayMinutes: avg(sessions?.avgDelay), toleranceMinutes: ON_TIME_MINUTES }
      : unavailable("No consultation session in this period has a recorded start time."),
    utilization:
      capacity == null || capacity === 0
        ? unavailable("No weekly availability is set for this period, so there is no capacity to compare with.")
        : { available: true, booked: bookedN, capacity, rate: pct(bookedN, capacity), basis: "current weekly schedule" },
  };
}

// ── Acquisition ─────────────────────────────────────────────────────────────
/** New patients in a day range by their ORIGINAL discovery source (no answer = not_captured). */
async function acquisitionBreakdown(doctorId, fromDay, toDay) {
  const rows = await q(
    `SELECT COALESCE(a.source_group, 'not_captured') AS grp, COALESCE(a.source, 'not_captured') AS src, COUNT(*) AS n
       FROM ${FIRST_VISITS} f
       LEFT JOIN patient_acquisition_sources a ON a.patient_id = f.patient_id AND a.doctor_id = :doctorId
      WHERE f.first_date BETWEEN :f AND :t
      GROUP BY grp, src`,
    { doctorId, treated: TREATED, f: fromDay, t: toDay }
  );
  return rows.map((x) => ({ group: x.grp, source: x.src, count: count(x.n) }));
}

function summarizeGroups(rows, prevRows) {
  const total = rows.reduce((a, r) => a + r.count, 0);
  const sumBy = (list, g) => list.filter((r) => r.group === g).reduce((a, r) => a + r.count, 0);
  const groups = [...ACQUISITION_GROUPS.map((g) => g.value), "not_captured"].map((g) => {
    const n = sumBy(rows, g);
    const meta = ACQUISITION_GROUPS.find((x) => x.value === g);
    return {
      group: g,
      label: meta?.label ?? "Not asked / no answer",
      count: n,
      percent: pct(n, total),
      previous: sumBy(prevRows, g),
      change: growth(n, sumBy(prevRows, g)),
      sources: rows
        .filter((r) => r.group === g && r.source !== "not_captured")
        .map((r) => ({ source: r.source, label: acquisition.labelOf(r.source), count: r.count }))
        .sort((a, b) => b.count - a.count),
    };
  });
  return { newPatients: total, groups };
}

async function acquisitionKpis(doctorId, p) {
  const [cur, prev] = await Promise.all([
    acquisitionBreakdown(doctorId, p.fromDay, p.toDay),
    acquisitionBreakdown(doctorId, p.prevFrom, p.prevTo),
  ]);
  return summarizeGroups(cur, prev);
}

// ── Overview (all sections, one call) ───────────────────────────────────────
async function overview(doctorId, query) {
  const p = resolvePeriod(query);
  const [patients, appointments, financial, quality, productivity, acq] = await Promise.all([
    patientKpis(doctorId, p),
    appointmentKpis(doctorId, p),
    financialKpis(doctorId, p),
    qualityKpis(doctorId, p),
    productivityKpis(doctorId, p),
    acquisitionKpis(doctorId, p),
  ]);
  return { period: periodOut(p), patients, appointments, financial, quality, productivity, acquisition: acq };
}

const periodOut = (p) => ({ from: p.fromDay, to: p.toDay, days: p.days, previousFrom: p.prevFrom, previousTo: p.prevTo, today: p.today });

// ── Trends (overview charts) ────────────────────────────────────────────────
async function trends(doctorId, query) {
  const p = resolvePeriod(query);
  const g = seriesGranularity(p, query.granularity);
  const r = { doctorId, treated: TREATED, f: p.fromDay, t: p.toDay, fromTs: p.fromTs, toTs: p.toTs, success: PS.SUCCESS, refunded: PS.REFUNDED };
  const sb = dateBucket(g, "b.slot_date");
  const [rev, refunds, appts, patients, acqRows] = await Promise.all([
    q(
      `SELECT ${instantBucket(g, "p.paid_at")} AS bucket, SUM(p.amount) AS collected, SUM(p.doctor_payout_amount) AS doctorNet
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = :success AND p.paid_at >= :fromTs AND p.paid_at < :toTs
        GROUP BY bucket`,
      r
    ),
    q(
      `SELECT ${instantBucket(g, "p.refunded_at")} AS bucket, SUM(p.refund_amount) AS refunded
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = :refunded AND p.refunded_at >= :fromTs AND p.refunded_at < :toTs
        GROUP BY bucket`,
      r
    ),
    q(
      `SELECT ${sb} AS bucket,
              SUM(b.status = 'completed') AS completed,
              SUM(b.status IN ('confirmed','pending_payment')) AS pending,
              SUM(${PERSON_CANCELLED}) AS cancelled,
              SUM(b.status = 'no_show') AS noShow,
              SUM(b.status IN ('confirmed','completed','no_show') AND b.booking_type = 'offline') AS clinic,
              SUM(b.status IN ('confirmed','completed','no_show') AND b.booking_type = 'online') AS video
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.slot_date BETWEEN :f AND :t AND ${REAL}
        GROUP BY bucket`,
      r
    ),
    q(
      `SELECT ${sb} AS bucket,
              COUNT(DISTINCT b.patient_id) AS unique_,
              COUNT(DISTINCT CASE WHEN ${dateBucket(g, "f.first_date")} = ${sb} THEN b.patient_id END) AS new_,
              COUNT(DISTINCT CASE WHEN ${dateBucket(g, "f.first_date")} < ${sb} THEN b.patient_id END) AS returning_
         FROM bookings b JOIN ${FIRST_VISITS} f ON f.patient_id = b.patient_id
        WHERE b.doctor_id = :doctorId AND b.status IN (:treated) AND b.slot_date BETWEEN :f AND :t
        GROUP BY bucket`,
      r
    ),
    q(
      `SELECT ${dateBucket(g, "f.first_date")} AS bucket, COALESCE(a.source_group, 'not_captured') AS grp, COUNT(*) AS n
         FROM ${FIRST_VISITS} f
         LEFT JOIN patient_acquisition_sources a ON a.patient_id = f.patient_id AND a.doctor_id = :doctorId
        WHERE f.first_date BETWEEN :f AND :t
        GROUP BY bucket, grp`,
      r
    ),
  ]);
  const range = { from: p.fromTs, to: p.toTs, granularity: g };
  const refundBy = new Map(refunds.map((x) => [x.bucket, money(x.refunded)]));
  const acqShape = Object.fromEntries([...ACQUISITION_GROUPS.map((x) => x.value), "not_captured"].map((k) => [k, 0]));
  const acqByBucket = new Map();
  for (const row of acqRows) {
    const cur = acqByBucket.get(row.bucket) ?? { bucket: row.bucket };
    cur[row.grp] = count(row.n);
    acqByBucket.set(row.bucket, cur);
  }
  return {
    period: periodOut(p),
    granularity: g,
    // Refunds are bucketed by when they happened (a refund can land in a bucket with no collections).
    revenue: zeroFill(
      rev.map((x) => ({ bucket: x.bucket, collected: money(x.collected), doctorNet: money(x.doctorNet) })),
      { ...range, shape: { collected: 0, doctorNet: 0 } }
    ).map((x) => ({ ...x, refunded: refundBy.get(x.bucket) ?? 0 })),
    appointments: zeroFill(
      appts.map((x) => ({
        bucket: x.bucket,
        completed: count(x.completed),
        pending: count(x.pending),
        cancelled: count(x.cancelled),
        noShow: count(x.noShow),
        clinic: count(x.clinic),
        video: count(x.video),
      })),
      { ...range, shape: { completed: 0, pending: 0, cancelled: 0, noShow: 0, clinic: 0, video: 0 } }
    ),
    patients: zeroFill(
      patients.map((x) => ({ bucket: x.bucket, unique: count(x.unique_), new: count(x.new_), returning: count(x.returning_) })),
      { ...range, shape: { unique: 0, new: 0, returning: 0 } }
    ),
    acquisition: zeroFill([...acqByBucket.values()], { ...range, shape: acqShape }),
  };
}

// ── Explore More: patients ──────────────────────────────────────────────────
async function patientsDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const { segment = "all", search, page = 1, limit = 20 } = query;
  const r = {
    doctorId,
    treated: TREATED,
    f: p.fromDay,
    t: p.toDay,
    today: p.today,
    like: search ? `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
    limit,
    offset: (page - 1) * limit,
  };
  // Patients with a real booking with this doctor in the period.
  const segmentSql =
    segment === "new" ? "AND f.first_date BETWEEN :f AND :t" : segment === "returning" ? "AND f.first_date < :f" : "";
  const base = `
    FROM (SELECT DISTINCT b.patient_id FROM bookings b
           WHERE b.doctor_id = :doctorId AND b.slot_date BETWEEN :f AND :t AND ${REAL}) inp
    JOIN users u ON u.id = inp.patient_id
    LEFT JOIN ${FIRST_VISITS} f ON f.patient_id = inp.patient_id
    WHERE 1 = 1 ${segmentSql} ${search ? "AND u.name LIKE :like" : ""}`;
  const [[totalRow], rows, kpis, timeline] = await Promise.all([
    q(`SELECT COUNT(*) AS n ${base}`, r),
    q(
      `SELECT inp.patient_id AS id, u.name, f.first_date AS firstVisit,
              (SELECT MAX(b.slot_date) FROM bookings b WHERE b.doctor_id = :doctorId AND b.patient_id = inp.patient_id AND b.status IN (:treated)) AS lastVisit,
              (SELECT COUNT(*) FROM bookings b WHERE b.doctor_id = :doctorId AND b.patient_id = inp.patient_id AND b.status IN (:treated)) AS visits,
              (SELECT COUNT(*) FROM bookings b WHERE b.doctor_id = :doctorId AND b.patient_id = inp.patient_id AND b.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM bookings b WHERE b.doctor_id = :doctorId AND b.patient_id = inp.patient_id AND ${PERSON_CANCELLED}) AS cancelled,
              (SELECT MIN(b.slot_date) FROM bookings b WHERE b.doctor_id = :doctorId AND b.patient_id = inp.patient_id AND b.status = 'confirmed' AND b.slot_date >= :today) AS upcoming,
              (SELECT a.source FROM patient_acquisition_sources a WHERE a.doctor_id = :doctorId AND a.patient_id = inp.patient_id) AS source
       ${base}
       ORDER BY lastVisit IS NULL, lastVisit DESC, inp.patient_id DESC
       LIMIT :limit OFFSET :offset`,
      r
    ),
    patientKpis(doctorId, p),
    trends(doctorId, { from: p.fromDay, to: p.toDay, granularity: query.granularity }).then((x) => ({ granularity: x.granularity, patients: x.patients })),
  ]);
  const total = count(totalRow?.n);
  return {
    period: periodOut(p),
    summary: kpis,
    timeline,
    patients: rows.map((x) => ({
      id: String(x.id),
      name: x.name,
      registrationNumber: regNoOf(x.id),
      firstVisit: x.firstVisit ? String(x.firstVisit).slice(0, 10) : null,
      lastVisit: x.lastVisit ? String(x.lastVisit).slice(0, 10) : null,
      visits: count(x.visits),
      completed: count(x.completed),
      cancelled: count(x.cancelled),
      upcoming: x.upcoming ? String(x.upcoming).slice(0, 10) : null,
      isNew: Boolean(x.firstVisit && String(x.firstVisit).slice(0, 10) >= p.fromDay && String(x.firstVisit).slice(0, 10) <= p.toDay),
      acquisitionSource: x.source ? { source: x.source, label: acquisition.labelOf(x.source) } : null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ── Explore More: appointments ──────────────────────────────────────────────
async function appointmentsDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const { status, mode, page = 1, limit = 20 } = query;
  const where = {
    doctorId,
    slotDate: { [Op.between]: [p.fromDay, p.toDay] },
    // NULL-safe: a cancelled booking with no reason is a real cancellation.
    [Op.and]: [
      sequelize.literal(
        "NOT (`Booking`.`status` = 'cancelled' AND COALESCE(`Booking`.`cancelled_reason`, '') IN ('hold_expired','order_failed'))"
      ),
    ],
  };
  if (status) where.status = status;
  if (mode) where.bookingType = mode === "video" ? "online" : "offline";
  const [kpis, list, series] = await Promise.all([
    appointmentKpis(doctorId, p),
    Booking.findAndCountAll({
      where,
      attributes: ["id", "slotDate", "slotStartTime", "slotEndTime", "queueNumber", "bookingType", "status", "amount", "rescheduledAt", "consultStartedAt", "consultEndedAt"],
      include: [
        { model: User, as: "patient", attributes: ["id", "name"] },
        { model: Clinic, as: "clinic", attributes: ["id", "name"], required: false },
        { model: Payment, as: "payment", attributes: ["status", "mode", "offlineMethod"], required: false },
      ],
      order: [["slotDate", "DESC"], ["queueNumber", "ASC"], ["id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    }),
    trends(doctorId, { from: p.fromDay, to: p.toDay, granularity: query.granularity }).then((x) => ({ granularity: x.granularity, appointments: x.appointments })),
  ]);
  return {
    period: periodOut(p),
    summary: kpis,
    trend: series,
    appointments: list.rows.map((b) => ({
      id: String(b.id),
      date: String(b.slotDate).slice(0, 10),
      sessionStart: b.slotStartTime,
      sessionEnd: b.slotEndTime,
      token: b.queueNumber,
      mode: b.bookingType === "online" ? "video" : "clinic",
      clinic: b.clinic ? { id: String(b.clinic.id), name: b.clinic.name } : null,
      patient: b.patient ? { id: String(b.patient.id), name: b.patient.name } : null,
      status: b.status,
      rescheduled: Boolean(b.rescheduledAt),
      amount: money(b.amount),
      paymentStatus: b.payment?.status ?? null,
      consultMinutes:
        b.consultStartedAt && b.consultEndedAt && b.consultEndedAt > b.consultStartedAt
          ? Math.round((b.consultEndedAt - b.consultStartedAt) / 60000)
          : null,
    })),
    total: list.count,
    page,
    limit,
    totalPages: Math.ceil(list.count / limit),
  };
}

// ── Explore More: financial ─────────────────────────────────────────────────
const METHOD_WHERE = {
  online: { mode: "online" },
  cash: { mode: "offline", offlineMethod: { [Op.or]: [OFFLINE_PAYMENT_METHOD.CASH, null] } },
  upi: { mode: "offline", offlineMethod: OFFLINE_PAYMENT_METHOD.UPI_QR },
};

async function financialDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const { method, status, page = 1, limit = 20 } = query;
  // A transaction belongs to the period by when money moved (paid / refunded),
  // or — for payments that never settled — when it was created.
  const when = {
    [Op.or]: [
      { paidAt: { [Op.gte]: p.fromTs, [Op.lt]: p.toTs } },
      { refundedAt: { [Op.gte]: p.fromTs, [Op.lt]: p.toTs } },
      { paidAt: null, refundedAt: null, createdAt: { [Op.gte]: p.fromTs, [Op.lt]: p.toTs } },
    ],
  };
  const where = { [Op.and]: [when, ...(method ? [METHOD_WHERE[method]] : []), ...(status ? [{ status }] : [])] };
  const [kpis, list, series] = await Promise.all([
    financialKpis(doctorId, p),
    Payment.findAndCountAll({
      where,
      attributes: ["id", "amount", "mode", "offlineMethod", "status", "refundAmount", "paidAt", "refundedAt", "createdAt", "razorpayPaymentId", "commissionAmount", "doctorPayoutAmount"],
      include: [
        {
          model: Booking,
          as: "booking",
          where: { doctorId },
          required: true,
          attributes: ["id", "bookingType", "slotDate", "amount"],
          include: [{ model: User, as: "patient", attributes: ["id", "name"] }],
        },
      ],
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
    }),
    trends(doctorId, { from: p.fromDay, to: p.toDay, granularity: query.granularity }).then((x) => ({ granularity: x.granularity, revenue: x.revenue })),
  ]);
  return {
    period: periodOut(p),
    summary: kpis,
    trend: series,
    transactions: list.rows.map((t) => ({
      id: String(t.id),
      gatewayReference: t.razorpayPaymentId ?? null,
      bookingId: String(t.booking.id),
      patient: t.booking.patient ? { id: String(t.booking.patient.id), name: t.booking.patient.name } : null,
      serviceType: t.booking.bookingType === "online" ? "Video consultation" : "Clinic consultation",
      method: t.mode === "online" ? "online" : t.offlineMethod === OFFLINE_PAYMENT_METHOD.UPI_QR ? "upi" : "cash",
      billed: money(t.booking.amount),
      collected: t.status === PS.SUCCESS ? money(t.amount) : 0,
      refunded: money(t.refundAmount),
      commission: t.status === PS.SUCCESS ? money(t.commissionAmount) : 0,
      doctorNet: t.status === PS.SUCCESS ? money(t.doctorPayoutAmount) : 0,
      status: t.status,
      date: (t.paidAt ?? t.refundedAt ?? t.createdAt)?.toISOString?.() ?? null,
    })),
    total: list.count,
    page,
    limit,
    totalPages: Math.ceil(list.count / limit),
  };
}

// ── Explore More: quality / productivity / acquisition ─────────────────────
async function qualityDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const g = seriesGranularity(p, query.granularity);
  const r = { doctorId, f: p.fromDay, t: p.toDay, today: p.today, finalized: PRESCRIPTION_STATUS.FINALIZED };
  const sb = dateBucket(g, "b.slot_date");
  const [kpis, appts, docSeries, followSeries] = await Promise.all([
    qualityKpis(doctorId, p),
    appointmentKpis(doctorId, p),
    q(
      `SELECT ${sb} AS bucket, COUNT(*) AS completed,
              SUM(EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.booking_id = b.id AND rx.status = :finalized)) AS documented
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.status = 'completed' AND b.slot_date BETWEEN :f AND :t
        GROUP BY bucket`,
      r
    ),
    q(
      `SELECT ${dateBucket(g, "x.follow_up_on")} AS bucket, COUNT(*) AS scheduled, SUM(x.done) AS completed,
              SUM(NOT x.done AND x.follow_up_on < :today) AS overdue
         FROM (SELECT fu.follow_up_on,
                      EXISTS (SELECT 1 FROM bookings nb WHERE nb.doctor_id = fu.doctor_id AND nb.patient_id = fu.patient_id
                                AND nb.status = 'completed' AND nb.slot_date > src.slot_date) AS done
                 FROM patient_follow_ups fu JOIN bookings src ON src.id = fu.booking_id
                WHERE fu.doctor_id = :doctorId AND fu.follow_up_on BETWEEN :f AND :t) x
        GROUP BY bucket`,
      r
    ),
  ]);
  const range = { from: p.fromTs, to: p.toTs, granularity: g };
  return {
    period: periodOut(p),
    granularity: g,
    summary: { ...kpis, completionRate: appts.period.completionRate, waitingTime: appts.waitingTime },
    documentation: zeroFill(
      docSeries.map((x) => ({ bucket: x.bucket, completed: count(x.completed), documented: count(x.documented) })),
      { ...range, shape: { completed: 0, documented: 0 } }
    ),
    followUps: zeroFill(
      followSeries.map((x) => ({ bucket: x.bucket, scheduled: count(x.scheduled), completed: count(x.completed), overdue: count(x.overdue) })),
      { ...range, shape: { scheduled: 0, completed: 0, overdue: 0 } }
    ),
  };
}

async function productivityDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const g = seriesGranularity(p, query.granularity);
  const sb = dateBucket(g, "b.slot_date");
  const r = { doctorId, f: p.fromDay, t: p.toDay };
  const [kpis, appts, series] = await Promise.all([
    productivityKpis(doctorId, p),
    appointmentKpis(doctorId, p),
    q(
      `SELECT ${sb} AS bucket, COUNT(*) AS consultations, COUNT(DISTINCT b.slot_date) AS days,
              COUNT(DISTINCT CONCAT(b.slot_date, '|', b.patient_id)) AS patientDays,
              SUM(b.booking_type = 'offline') AS clinic, SUM(b.booking_type = 'online') AS video,
              AVG(CASE WHEN b.consult_ended_at > b.consult_started_at
                        AND TIMESTAMPDIFF(SECOND, b.consult_started_at, b.consult_ended_at) <= ${MAX_CONSULT_SECONDS}
                       THEN TIMESTAMPDIFF(SECOND, b.consult_started_at, b.consult_ended_at) END) / 60 AS avgMinutes
         FROM bookings b WHERE b.doctor_id = :doctorId AND b.status = 'completed' AND b.slot_date BETWEEN :f AND :t
        GROUP BY bucket`,
      r
    ),
  ]);
  const range = { from: p.fromTs, to: p.toTs, granularity: g };
  return {
    period: periodOut(p),
    granularity: g,
    summary: { ...kpis, consultDuration: appts.consultDuration, completionRate: appts.period.completionRate },
    series: zeroFill(
      series.map((x) => ({
        bucket: x.bucket,
        consultations: count(x.consultations),
        workingDays: count(x.days),
        patients: count(x.patientDays),
        consultationsPerDay: count(x.days) ? avg(count(x.consultations) / count(x.days)) : 0,
        clinic: count(x.clinic),
        video: count(x.video),
        averageMinutes: x.avgMinutes == null ? null : avg(x.avgMinutes),
      })),
      { ...range, shape: { consultations: 0, workingDays: 0, patients: 0, consultationsPerDay: 0, clinic: 0, video: 0, averageMinutes: null } }
    ),
  };
}

async function acquisitionDetail(doctorId, query) {
  const p = resolvePeriod(query);
  const [summary, allTime, series, captured] = await Promise.all([
    acquisitionKpis(doctorId, p),
    acquisitionBreakdown(doctorId, "1970-01-01", p.today).then((rows) => summarizeGroups(rows, [])),
    trends(doctorId, { from: p.fromDay, to: p.toDay, granularity: query.granularity }),
    q(
      `SELECT COUNT(*) AS answered FROM booking_acquisition_sources WHERE doctor_id = :doctorId AND created_at >= :fromTs AND created_at < :toTs`,
      { doctorId, fromTs: p.fromTs, toTs: p.toTs }
    ),
  ]);
  return {
    period: periodOut(p),
    summary,
    allTime,
    bookingAnswersInPeriod: count(captured?.[0]?.answered),
    granularity: series.granularity,
    monthly: series.acquisition,
    newVsReturning: series.patients,
  };
}

module.exports = {
  resolvePeriod,
  overview,
  trends,
  patientsDetail,
  appointmentsDetail,
  financialDetail,
  qualityDetail,
  productivityDetail,
  acquisitionDetail,
};
