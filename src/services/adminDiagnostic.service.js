/**
 * Admin Diagnostic Lab tracking (migration 038) — read-only aggregates over the
 * diagnostic tables, in the same raw-SQL + Promise.all shape as
 * adminMedicine.service. Nothing here writes.
 *
 * Privacy: the admin sees the WORKFLOW (who → which lab → which step, when),
 * and counts of tests / reports — never the prescription file, the report file
 * or the names of the tests a patient booked.
 */
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../models");
const { ROLES, RECORD_SOURCES, DIAGNOSTIC_REQUEST_STATUS } = require("../config/constants");

const select = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const num = (v) => Number(v || 0);

const zeroStatuses = () => Object.fromEntries(Object.values(DIAGNOSTIC_REQUEST_STATUS).map((s) => [s, 0]));

exports.overview = async () => {
  const lab = { role: ROLES.DIAGNOSTIC_LAB };
  const [[labs], [requests], byStatus, [tests], [reports], perLab] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active FROM users WHERE role = :role`,
      lab
    ),
    select(`
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT patient_id) AS patients,
             COALESCE(SUM(responded_at IS NOT NULL), 0) AS responded,
             COALESCE(SUM(booking_requested_at IS NOT NULL), 0) AS bookings,
             COALESCE(SUM(confirmed_at IS NOT NULL), 0) AS confirmed,
             COALESCE(SUM(completed_at IS NOT NULL), 0) AS completed
        FROM diagnostic_requests`),
    select(`SELECT status, COUNT(*) AS n FROM diagnostic_requests GROUP BY status`),
    select(`SELECT COUNT(*) AS total FROM diagnostic_tests WHERE is_active = 1`),
    select(`SELECT COUNT(*) AS total FROM uploaded_records WHERE source = :source`, {
      source: RECORD_SOURCES.DIAGNOSTIC_LAB,
    }),
    select(
      `SELECT u.id, u.name, u.city, u.state, u.is_active AS isActive, u.created_at AS createdAt,
              COALESCE(r.requests, 0) AS requests, COALESCE(r.bookings, 0) AS bookings,
              COALESCE(r.completed, 0) AS completed, COALESCE(rep.reports, 0) AS reports,
              COALESCE(t.tests, 0) AS tests
         FROM users u
         LEFT JOIN (SELECT lab_id, COUNT(*) AS requests,
                           SUM(booking_requested_at IS NOT NULL) AS bookings,
                           SUM(completed_at IS NOT NULL) AS completed
                      FROM diagnostic_requests GROUP BY lab_id) r ON r.lab_id = u.id
         LEFT JOIN (SELECT recorded_by_user_id AS lab_id, COUNT(*) AS reports
                      FROM uploaded_records WHERE source = :source
                     GROUP BY recorded_by_user_id) rep ON rep.lab_id = u.id
         LEFT JOIN (SELECT lab_id, COUNT(*) AS tests
                      FROM diagnostic_tests WHERE is_active = 1 GROUP BY lab_id) t ON t.lab_id = u.id
        WHERE u.role = :role
        ORDER BY requests DESC, u.name ASC`,
      { ...lab, source: RECORD_SOURCES.DIAGNOSTIC_LAB }
    ),
  ]);

  const statuses = zeroStatuses();
  byStatus.forEach((r) => {
    statuses[r.status] = num(r.n);
  });

  return {
    labs: { total: num(labs.total), active: num(labs.active), inactive: num(labs.total) - num(labs.active) },
    requests: {
      total: num(requests.total),
      patients: num(requests.patients),
      responded: num(requests.responded),
      byStatus: statuses,
    },
    bookings: {
      total: num(requests.bookings),
      confirmed: num(requests.confirmed),
      completed: num(requests.completed),
    },
    reports: { total: num(reports.total) },
    tests: { total: num(tests.total) },
    perLab: perLab.map((r) => ({
      id: String(r.id),
      name: r.name,
      city: r.city,
      state: r.state,
      isActive: Boolean(num(r.isActive)),
      createdAt: r.createdAt,
      requests: num(r.requests),
      bookings: num(r.bookings),
      completed: num(r.completed),
      reports: num(r.reports),
      tests: num(r.tests),
    })),
  };
};

/**
 * The workflow ledger: one row per request with every step's timestamp —
 * Patient → Lab → Request → Availability → Booking → Completion → Report.
 */
exports.listRequests = async ({ status, labId, from, to, page = 1, limit = 20 } = {}) => {
  const clauses = [];
  const replacements = {};
  if (status) {
    clauses.push("r.status = :status");
    replacements.status = status;
  }
  if (labId) {
    clauses.push("r.lab_id = :labId");
    replacements.labId = labId;
  }
  if (from) {
    clauses.push("r.created_at >= :from");
    replacements.from = from;
  }
  if (to) {
    clauses.push("r.created_at < :to");
    replacements.to = to;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [rows, [{ total }]] = await Promise.all([
    select(
      `SELECT r.id, r.status, r.created_at AS createdAt, r.responded_at AS respondedAt,
              r.booking_requested_at AS bookingRequestedAt,
              DATE_FORMAT(r.preferred_date, '%Y-%m-%d') AS preferredDate,
              r.confirmed_at AS confirmedAt, r.completed_at AS completedAt,
              r.report_ready_at AS reportReadyAt,
              p.id AS patientId, p.name AS patientName,
              l.id AS labId, l.name AS labName, l.city AS labCity,
              COALESCE(t.available, 0) AS testsAvailable, COALESCE(t.unavailable, 0) AS testsUnavailable,
              COALESCE(t.selected, 0) AS testsBooked, COALESCE(t.reported, 0) AS testsReported
         FROM diagnostic_requests r
         JOIN users p ON p.id = r.patient_id
         JOIN users l ON l.id = r.lab_id
         LEFT JOIN (SELECT diagnostic_request_id,
                           SUM(status = 'available') AS available,
                           SUM(status = 'unavailable') AS unavailable,
                           SUM(is_selected = 1) AS selected,
                           SUM(report_record_id IS NOT NULL) AS reported
                      FROM diagnostic_request_tests GROUP BY diagnostic_request_id) t
                ON t.diagnostic_request_id = r.id
         ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT :limit OFFSET :offset`,
      { ...replacements, limit, offset: (page - 1) * limit }
    ),
    select(`SELECT COUNT(*) AS total FROM diagnostic_requests r ${where}`, replacements),
  ]);

  return {
    requests: rows.map((r) => ({
      id: String(r.id),
      status: r.status,
      createdAt: r.createdAt,
      respondedAt: r.respondedAt,
      bookingRequestedAt: r.bookingRequestedAt,
      preferredDate: r.preferredDate,
      confirmedAt: r.confirmedAt,
      completedAt: r.completedAt,
      reportReadyAt: r.reportReadyAt,
      patient: { id: String(r.patientId), name: r.patientName },
      lab: { id: String(r.labId), name: r.labName, city: r.labCity },
      tests: {
        available: num(r.testsAvailable),
        unavailable: num(r.testsUnavailable),
        booked: num(r.testsBooked),
        reported: num(r.testsReported),
      },
    })),
    total: num(total),
    page,
    limit,
    totalPages: Math.ceil(num(total) / limit),
  };
};
