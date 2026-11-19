/**
 * Dashboard tiles for all three portals (docs/dashboards-earnings/backend-plan.md §5).
 *
 * Counts, not money — except where it DELEGATES to earnings.service rather than
 * re-deriving a sum. The doctor's "earned this month" is
 * `earningsService.doctorSummary(...)`, not a fourth copy of the same SUM.
 *
 * Everything here aggregates in SQL. The patient tiles in particular exist
 * because the frontend used to fetch the whole booking list and count it with
 * `.filter()` — correct only while `GET /patient/bookings` returns everything,
 * and silently under-reporting the day it grows a `?page=`.
 */
const { Op, fn, col, QueryTypes } = require("sequelize");
const { sequelize, Booking, Payment, DoctorProfile, User, Clinic, ClinicProfile } = require("../models");
const earningsService = require("./earnings.service");
const { istToday, istMonthBounds } = require("../utils/period");
const { BOOKING_STATUS, PAYMENT_STATUS, BOOKING_PAYMENT_VIEW_ATTRS } = require("../config/constants");

const { money, count } = earningsService;

/**
 * ONE `GROUP BY status` query → `{ confirmed: 3, completed: 11, ... }`.
 * Four separate COUNT(*) round-trips would give the same answer for 4× the cost.
 */
async function countsByStatus(where) {
  const rows = await Booking.findAll({
    attributes: ["status", [fn("COUNT", col("id")), "n"]],
    where,
    group: ["status"],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

// ── Patient ──────────────────────────────────────────────────────────────────

async function patientSummary(patientId) {
  const today = istToday();

  const [byStatus, distinctDoctors, spend, next] = await Promise.all([
    countsByStatus({ patientId }),

    Booking.count({
      distinct: true,
      col: "doctorId",
      where: {
        patientId,
        status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED] },
      },
    }),

    // The patient's view of money is GROSS (what they paid). Commission is
    // invisible to them and must never surface in this app.
    //
    // Raw SQL, not `Payment.sum(..., { include })`: Sequelize's aggregate
    // shortcuts don't reliably build the JOIN, and a silently unfiltered SUM
    // here would show a patient the whole platform's takings.
    sequelize
      .query(
        `SELECT SUM(p.amount) AS spent
           FROM payments p
           JOIN bookings b ON b.id = p.booking_id
          WHERE b.patient_id = :patientId AND p.status = :success`,
        {
          replacements: { patientId, success: PAYMENT_STATUS.SUCCESS },
          type: QueryTypes.SELECT,
        }
      )
      .then(([r]) => r?.spent),

    Booking.findOne({
      where: {
        patientId,
        status: BOOKING_STATUS.CONFIRMED,
        slotDate: { [Op.gte]: today },
      },
      order: [["slotDate", "ASC"], ["slotStartTime", "ASC"]],
      include: [
        {
          model: DoctorProfile,
          as: "doctor",
          attributes: ["userId"],
          include: [{ model: User, as: "user", attributes: ["id", "name"] }],
        },
      ],
    }),
  ]);

  // "Upcoming" is confirmed AND not in the past — a confirmed booking whose date
  // has passed but which the doctor never marked completed is not upcoming.
  const upcoming = await Booking.count({
    where: { patientId, status: BOOKING_STATUS.CONFIRMED, slotDate: { [Op.gte]: today } },
  });

  return {
    upcoming,
    completed: byStatus[BOOKING_STATUS.COMPLETED] ?? 0,
    pendingPayment: byStatus[BOOKING_STATUS.PENDING] ?? 0,
    doctorsConsulted: count(distinctDoctors),
    totalSpent: money(spend),
    nextAppointment: next,
  };
}

// ── Doctor ───────────────────────────────────────────────────────────────────

async function doctorSummary(doctorId) {
  const today = istToday();
  const month = istMonthBounds();

  const [todaysByType, patientsThisMonth, earnings, practice, appointments] = await Promise.all([
    // Today's appointments split by the canonical booking_type (online = video,
    // offline = clinic). Same filter as before: confirmed + completed only.
    Booking.count({
      where: {
        doctorId,
        slotDate: today,
        status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED] },
      },
      group: ["bookingType"],
    }),

    Booking.count({
      distinct: true,
      col: "patientId",
      where: {
        doctorId,
        // `slot_date` is a DATEONLY, so bound it with IST calendar dates rather
        // than the UTC instants used for money.
        slotDate: { [Op.gte]: istDateOf(month.from), [Op.lt]: istDateOf(month.to) },
        status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED] },
      },
    }),

    earningsService.doctorSummary(doctorId, month),

    doctorLifetimeTotals(doctorId),

    doctorAppointmentCounts(doctorId, today),
  ]);

  const byType = Object.fromEntries(todaysByType.map((r) => [r.bookingType, count(r.count)]));
  const todaysVideo = byType.online ?? 0;
  const todaysClinic = byType.offline ?? 0;

  return {
    todaysAppointments: todaysVideo + todaysClinic,
    todaysClinic,
    todaysVideo,
    patientsThisMonth: count(patientsThisMonth),
    // No `reviews` table exists (dbstruct.md §17 is designed but unmigrated).
    // null, NEVER 0 — a 0 renders as a zero-star doctor. The field is in the
    // contract from day one so the reviews plan is a fill-in, not a reshape.
    averageRating: null,
    earnedThisMonth: earnings.net,
    // Overview KPI row (all-time). Same patient rules as the EMR workbench:
    // "patients" = confirmed or completed bookings, "consulted" = completed.
    totalPatients: practice.totalPatients,
    consultedPatients: practice.consultedPatients,
    totalRevenue: practice.totalRevenue,
    appointments,
  };
}

/** Booking statuses that count as an appointment — every non-cancelled booking. */
const APPOINTMENT_STATUSES = [
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.NO_SHOW,
];
/** Still to be seen: awaiting payment, or paid and not yet consulted. */
const PENDING_APPOINTMENT_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED];

/**
 * All-time unique patients and received revenue.
 *
 * Revenue follows earnings.service's rules: only `success` payments are money
 * (pending-at-clinic, initiated, failed and refunded are not), and the doctor's
 * share is READ from `doctor_payout_amount`, never re-derived.
 */
async function doctorLifetimeTotals(doctorId) {
  const [[patients], [revenue]] = await Promise.all([
    sequelize.query(
      `SELECT COUNT(DISTINCT CASE WHEN b.status IN (:treated) THEN b.patient_id END) AS totalPatients,
              COUNT(DISTINCT CASE WHEN b.status = :completed THEN b.patient_id END) AS consultedPatients
         FROM bookings b
        WHERE b.doctor_id = :doctorId`,
      {
        replacements: {
          doctorId,
          treated: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED],
          completed: BOOKING_STATUS.COMPLETED,
        },
        type: QueryTypes.SELECT,
      }
    ),
    sequelize.query(
      `SELECT SUM(p.doctor_payout_amount) AS net
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE b.doctor_id = :doctorId AND p.status = :success`,
      { replacements: { doctorId, success: PAYMENT_STATUS.SUCCESS }, type: QueryTypes.SELECT }
    ),
  ]);
  return {
    totalPatients: count(patients?.totalPatients),
    consultedPatients: count(patients?.consultedPatients),
    totalRevenue: money(revenue?.net),
  };
}

/**
 * The overview's appointment breakdown in ONE query. `today`, `previous` and
 * `upcoming` partition `total` by IST slot date (they always add up to it);
 * `pending` cuts across them by status.
 */
async function doctorAppointmentCounts(doctorId, today) {
  const [row] = await sequelize.query(
    `SELECT COUNT(*)                          AS total,
            SUM(b.slot_date = :today)         AS today,
            SUM(b.slot_date < :today)         AS previous,
            SUM(b.slot_date > :today)         AS upcoming,
            SUM(b.status IN (:pendingStatuses)) AS pending
       FROM bookings b
      WHERE b.doctor_id = :doctorId AND b.status IN (:statuses)`,
    {
      replacements: {
        doctorId,
        today,
        statuses: APPOINTMENT_STATUSES,
        pendingStatuses: PENDING_APPOINTMENT_STATUSES,
      },
      type: QueryTypes.SELECT,
    }
  );
  return {
    today: count(row?.today),
    total: count(row?.total),
    pending: count(row?.pending),
    previous: count(row?.previous),
    upcoming: count(row?.upcoming),
  };
}

/** A UTC instant → the IST calendar date ('YYYY-MM-DD') it falls on. */
function istDateOf(instant) {
  return istToday(instant);
}

/** The doctor's schedule for today — the overview's right-hand card. */
async function doctorToday(doctorId) {
  return Booking.findAll({
    where: {
      doctorId,
      slotDate: istToday(),
      status: { [Op.in]: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED] },
    },
    order: [["slotStartTime", "ASC"]],
    include: [
      { model: User, as: "patient", attributes: ["id", "name"] },
      { model: Payment, as: "payment", attributes: [...BOOKING_PAYMENT_VIEW_ATTRS] },
    ],
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

async function adminSummary(range) {
  const month = istMonthBounds();

  const [doctorCounts, bookingsThisMonth, platform, totalDoctors, totalPatients, totalClinics, totalBookings] = await Promise.all([
    DoctorProfile.findAll({
      attributes: ["verificationStatus", [fn("COUNT", col("user_id")), "n"]],
      group: ["verificationStatus"],
      raw: true,
    }),

    Booking.count({
      where: {
        slotDate: { [Op.gte]: istDateOf(month.from), [Op.lt]: istDateOf(month.to) },
        status: { [Op.ne]: BOOKING_STATUS.CANCELLED },
      },
    }),

    earningsService.platformSummary(range ?? month),

    User.count({ where: { role: "doctor" } }),

    User.count({ where: { role: "patient" } }),

    ClinicProfile.count(),

    Booking.count(),
  ]);

  const byStatus = Object.fromEntries(doctorCounts.map((r) => [r.verificationStatus, Number(r.n)]));

  return {
    verifiedDoctors: byStatus.approved ?? 0,
    pendingVerifications: byStatus.pending ?? 0,
    bookingsThisMonth: count(bookingsThisMonth),
    totalDoctors: count(totalDoctors),
    totalPatients: count(totalPatients),
    totalClinics: count(totalClinics),
    totalBookings: count(totalBookings),
    platformRevenue: platform.platformRevenue,
    gmv: platform.gmv,
    doctorPayouts: platform.doctorPayouts,
  };
}

/**
 * All bookings for the admin appointments page, newest first.
 * Supports filtering by status and search by doctor/patient name.
 */
async function adminBookings({ status, q } = {}) {
  const where = {};
  if (status) where.status = status;

  // Search by doctor or patient name — requires two OR conditions on joined tables.
  const include = [
    {
      model: DoctorProfile,
      as: "doctor",
      attributes: ["userId"],
      include: [{ model: User, as: "user", attributes: ["id", "name"] }],
    },
    {
      model: User,
      as: "patient",
      attributes: ["id", "name"],
    },
    {
      model: Clinic,
      as: "clinic",
      attributes: ["id", "name", "city"],
    },
    {
      model: Payment,
      as: "payment",
      attributes: ["status"],
    },
  ];

  // If searching by name, add a WHERE condition on doctor or patient name.
  if (q) {
    where[Op.or] = [
      { "$doctor.user.name$": { [Op.like]: `%${q}%` } },
      { "$patient.name$": { [Op.like]: `%${q}%` } },
    ];
  }

  return Booking.findAll({
    where,
    include,
    order: [["slotDate", "DESC"], ["slotStartTime", "DESC"]],
  });
}

module.exports = {
  patientSummary,
  doctorSummary,
  doctorToday,
  adminSummary,
  adminBookings,
};
