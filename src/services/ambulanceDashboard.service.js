/**
 * Ambulance provider dashboard + admin ambulance statistics (migration 040).
 * Read-only aggregates computed by the database (COUNT / SUM / GROUP BY) in
 * one Promise.all — the same shape as bloodDashboard.service: no list is
 * loaded just to be counted.
 */
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../models");
const { ROLES } = require("../config/constants");
const A = require("../config/ambulance");
const bookingService = require("./ambulanceBooking.service");

const select = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const num = (v) => Number(v || 0);
const TREND_DAYS = 14;
const S = A.AMBULANCE_BOOKING_STATUS;

const common = {
  approved: A.AMBULANCE_VERIFICATION.APPROVED,
  pending: A.AMBULANCE_VERIFICATION.PENDING,
  rejected: A.AMBULANCE_VERIFICATION.REJECTED,
  available: A.AMBULANCE_AVAILABILITY.AVAILABLE,
  onTrip: A.AMBULANCE_AVAILABILITY.ON_TRIP,
  offline: [A.AMBULANCE_AVAILABILITY.OFFLINE, A.AMBULANCE_AVAILABILITY.MAINTENANCE],
  requested: S.REQUESTED,
  active: A.AMBULANCE_ACTIVE_BOOKING,
  completed: S.COMPLETED,
  cancelled: S.CANCELLED,
  rejectedBooking: S.REJECTED,
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Fill a day-bucketed series so empty days render as 0, not gaps. */
function series(rows, days) {
  const byDay = new Map(rows.map((r) => [String(r.day), num(r.n)]));
  const out = [];
  const d = startOfToday();
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ day: key, value: byDay.get(key) || 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const bookingCountsSql = (where) => `
  SELECT COUNT(*) AS total,
         COALESCE(SUM(status = :requested), 0) AS requested,
         COALESCE(SUM(status IN (:active)), 0) AS ongoing,
         COALESCE(SUM(status = :completed), 0) AS completed,
         COALESCE(SUM(status = :cancelled), 0) AS cancelled,
         COALESCE(SUM(status = :rejectedBooking), 0) AS rejected,
         COALESCE(SUM(created_at >= :today), 0) AS today,
         COALESCE(SUM(CASE WHEN status = :completed THEN COALESCE(final_fare, estimated_fare) ELSE 0 END), 0) AS completedFare
    FROM ambulance_bookings ${where}`;

const shapeBookings = (b) => ({
  total: num(b.total),
  requested: num(b.requested),
  ongoing: num(b.ongoing),
  completed: num(b.completed),
  cancelled: num(b.cancelled),
  rejected: num(b.rejected),
  today: num(b.today),
  completedFare: Number(b.completedFare || 0),
});

/** The provider's own dashboard (scoped by provider_id). */
exports.providerDashboard = async (providerId) => {
  const r = { ...common, providerId, today: startOfToday() };
  const [[fleet], [drivers], [bookings], recent] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(verification_status = :pending), 0) AS pendingApproval,
              COALESCE(SUM(verification_status = :rejected), 0) AS rejected,
              COALESCE(SUM(verification_status = :approved AND is_active = 1), 0) AS active,
              COALESCE(SUM(verification_status = :approved AND is_active = 1 AND availability_status = :available), 0) AS available,
              COALESCE(SUM(availability_status = :onTrip), 0) AS onTrip,
              COALESCE(SUM(availability_status IN (:offline)), 0) AS offline
         FROM ambulances WHERE provider_id = :providerId`,
      r
    ),
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active
         FROM ambulance_drivers WHERE provider_id = :providerId`,
      r
    ),
    select(bookingCountsSql("WHERE provider_id = :providerId"), r),
    bookingService.listForProvider(providerId, { bucket: "open", page: 1, limit: 5 }),
  ]);
  return {
    ambulances: {
      total: num(fleet.total),
      pendingApproval: num(fleet.pendingApproval),
      rejected: num(fleet.rejected),
      active: num(fleet.active),
      available: num(fleet.available),
      onTrip: num(fleet.onTrip),
      offline: num(fleet.offline),
    },
    drivers: { total: num(drivers.total), active: num(drivers.active) },
    bookings: shapeBookings(bookings),
    openBookings: recent.bookings,
  };
};

/** Platform-wide ambulance overview for the admin portal. */
exports.adminSummary = async () => {
  const r = {
    ...common,
    role: ROLES.AMBULANCE_PROVIDER,
    today: startOfToday(),
    since: new Date(startOfToday().getTime() - (TREND_DAYS - 1) * 86400000),
  };
  const [[providers], [fleet], [bookings], byType, byStatus, trend] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(p.verification_status = :pending), 0) AS pending,
              COALESCE(SUM(p.verification_status = :approved), 0) AS approved,
              COALESCE(SUM(p.verification_status = :rejected), 0) AS rejected,
              COALESCE(SUM(p.is_active = 0 OR u.is_active = 0), 0) AS suspended
         FROM users u LEFT JOIN ambulance_provider_profiles p ON p.user_id = u.id
        WHERE u.role = :role`,
      r
    ),
    select(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(verification_status = :pending), 0) AS pending,
              COALESCE(SUM(verification_status = :approved), 0) AS approved,
              COALESCE(SUM(verification_status = :rejected), 0) AS rejected,
              COALESCE(SUM(verification_status = :approved AND is_active = 1), 0) AS active,
              COALESCE(SUM(verification_status = :approved AND is_active = 1 AND availability_status = :available), 0) AS available,
              COALESCE(SUM(verification_status = :approved AND (is_active = 0 OR availability_status <> :available)), 0) AS unavailable,
              COALESCE(SUM(availability_status = :onTrip), 0) AS onTrip,
              COALESCE(SUM(is_active = 0), 0) AS deactivated
         FROM ambulances`,
      r
    ),
    select(bookingCountsSql(""), r),
    select(
      `SELECT ambulance_type AS type, COUNT(*) AS n FROM ambulances
        WHERE verification_status = :approved AND is_active = 1
        GROUP BY ambulance_type ORDER BY n DESC`,
      r
    ),
    select(`SELECT status, COUNT(*) AS n FROM ambulance_bookings GROUP BY status`, r),
    select(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM ambulance_bookings
        WHERE created_at >= :since GROUP BY day ORDER BY day`,
      r
    ),
  ]);
  return {
    providers: {
      total: num(providers.total),
      pending: num(providers.pending),
      approved: num(providers.approved),
      rejected: num(providers.rejected),
      suspended: num(providers.suspended),
    },
    ambulances: {
      total: num(fleet.total),
      pending: num(fleet.pending),
      approved: num(fleet.approved),
      rejected: num(fleet.rejected),
      active: num(fleet.active),
      available: num(fleet.available),
      unavailable: num(fleet.unavailable),
      onTrip: num(fleet.onTrip),
      deactivated: num(fleet.deactivated),
    },
    bookings: shapeBookings(bookings),
    charts: {
      byType: byType.map((t) => ({ type: t.type, label: A.AMBULANCE_TYPES[t.type]?.label || t.type, count: num(t.n) })),
      bookingsByStatus: byStatus.map((s) => ({ status: s.status, label: A.AMBULANCE_STATUS_LABELS[s.status] || s.status, count: num(s.n) })),
      bookingTrend: series(trend, TREND_DAYS),
    },
  };
};
