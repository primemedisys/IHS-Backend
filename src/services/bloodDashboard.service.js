/**
 * Blood-bank dashboard + admin blood statistics (migration 039). Read-only
 * aggregates computed by the database (COUNT / SUM / GROUP BY) in one
 * Promise.all, the same shape as adminMedicine.service — no list is loaded
 * just to be counted, and nothing here writes (except the once-a-day
 * expiring-stock notification, below).
 */
const { Op, QueryTypes } = require("sequelize");
const { sequelize, MedicineNotification } = require("../models");
const audit = require("./bloodAudit.service");
const inventory = require("./bloodInventory.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

const select = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const num = (v) => Number(v || 0);
const TREND_DAYS = 14;
const IN_STOCK = B.UNIT_IN_STOCK;
const OPEN = [B.BLOOD_REQUEST_STATUS.PENDING, B.BLOOD_REQUEST_STATUS.VIEWED, B.BLOOD_REQUEST_STATUS.PROCESSING];

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

/**
 * At most one "units expiring soon" notification per bank per day, created
 * when the dashboard is opened and stock is due to expire.
 */
async function notifyExpiringOnce(bloodBankId, expiring) {
  if (!expiring) return;
  const already = await MedicineNotification.count({
    where: { userId: bloodBankId, type: "blood_expiring_soon", createdAt: { [Op.gte]: startOfToday() } },
  });
  if (already) return;
  await audit.notify({
    userId: bloodBankId,
    title: "Blood units expiring soon",
    message: `${expiring} unit(s) expire within ${B.BLOOD_EXPIRY_WARNING_DAYS} days. Review inventory to use or reallocate them.`,
    type: "blood_expiring_soon",
    referenceId: bloodBankId,
    referenceType: B.BLOOD_NOTIFICATION_REF.INVENTORY,
  });
}

exports.bankDashboard = async (bloodBankId) => {
  await inventory.expireDue(bloodBankId);
  const r = {
    bank: bloodBankId,
    inStock: IN_STOCK,
    available: B.UNIT_STATUS.AVAILABLE,
    reserved: B.UNIT_STATUS.RESERVED,
    testingSet: [B.UNIT_STATUS.QUARANTINE, B.UNIT_STATUS.TESTING],
    expiringSet: [B.UNIT_STATUS.AVAILABLE, B.UNIT_STATUS.RESERVED],
    cutoff: new Date(Date.now() + B.BLOOD_EXPIRY_WARNING_DAYS * 86400000),
    now: new Date(),
    today: startOfToday(),
    open: OPEN,
    allOpen: B.BLOOD_REQUEST_OPEN,
    since: new Date(startOfToday().getTime() - (TREND_DAYS - 1) * 86400000),
  };
  const [[units], [donations], [requests], [issues], [donors], byGroup, byComponent, byStatus, donationTrend, issueTrend, expiringByDay] =
    await Promise.all([
      select(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = :available), 0) AS available,
                COALESCE(SUM(status = :reserved), 0) AS reserved,
                COALESCE(SUM(status IN (:testingSet)), 0) AS pendingTesting,
                COALESCE(SUM(status IN (:expiringSet) AND expires_at <= :cutoff), 0) AS expiringSoon
           FROM blood_units WHERE blood_bank_id = :bank AND status IN (:inStock)`,
        r
      ),
      select(`SELECT COUNT(*) AS today FROM blood_donations WHERE blood_bank_id = :bank AND collected_at >= :today`, r),
      select(
        `SELECT COALESCE(SUM(status IN (:open)), 0) AS pending,
                COALESCE(SUM(is_emergency = 1 AND status IN (:allOpen)), 0) AS emergency
           FROM blood_requests WHERE blood_bank_id = :bank`,
        r
      ),
      select(`SELECT COUNT(*) AS today FROM blood_issues WHERE blood_bank_id = :bank AND issued_at >= :today`, r),
      select(`SELECT COUNT(*) AS total FROM blood_donors WHERE blood_bank_id = :bank`, r),
      select(
        `SELECT blood_group AS bloodGroup, COUNT(*) AS n FROM blood_units
          WHERE blood_bank_id = :bank AND status = :available GROUP BY blood_group`,
        r
      ),
      select(
        `SELECT component, COUNT(*) AS n FROM blood_units
          WHERE blood_bank_id = :bank AND status = :available GROUP BY component`,
        r
      ),
      select(`SELECT status, COUNT(*) AS n FROM blood_requests WHERE blood_bank_id = :bank GROUP BY status`, r),
      select(
        `SELECT DATE_FORMAT(collected_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM blood_donations
          WHERE blood_bank_id = :bank AND collected_at >= :since GROUP BY day`,
        r
      ),
      select(
        `SELECT DATE_FORMAT(issued_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM blood_issues
          WHERE blood_bank_id = :bank AND issued_at >= :since GROUP BY day`,
        r
      ),
      select(
        `SELECT DATE_FORMAT(expires_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM blood_units
          WHERE blood_bank_id = :bank AND status IN (:expiringSet) AND expires_at > :now AND expires_at <= :cutoff
          GROUP BY day ORDER BY day`,
        r
      ),
    ]);

  await notifyExpiringOnce(bloodBankId, num(units.expiringSoon));
  const groupMap = new Map(byGroup.map((g) => [g.bloodGroup, num(g.n)]));
  const statusMap = new Map(byStatus.map((s) => [s.status, num(s.n)]));
  return {
    cards: {
      totalUnits: num(units.total),
      availableUnits: num(units.available),
      reservedUnits: num(units.reserved),
      pendingTesting: num(units.pendingTesting),
      expiringSoon: num(units.expiringSoon),
      pendingRequests: num(requests.pending),
      emergencyRequests: num(requests.emergency),
      todaysDonations: num(donations.today),
      todaysIssues: num(issues.today),
      registeredDonors: num(donors.total),
    },
    charts: {
      inventoryByGroup: B.BLOOD_GROUPS.map((g) => ({ bloodGroup: g, available: groupMap.get(g) || 0 })),
      inventoryByComponent: byComponent.map((c) => ({
        component: c.component,
        label: B.BLOOD_COMPONENTS[c.component]?.label || c.component,
        available: num(c.n),
      })),
      requestStatus: Object.values(B.BLOOD_REQUEST_STATUS).map((s) => ({ status: s, count: statusMap.get(s) || 0 })),
      donationTrend: series(donationTrend, TREND_DAYS),
      issueTrend: series(issueTrend, TREND_DAYS),
      expiringByDay: expiringByDay.map((e) => ({ day: e.day, value: num(e.n) })),
    },
    expiryWarningDays: B.BLOOD_EXPIRY_WARNING_DAYS,
  };
};

// ── Admin ────────────────────────────────────────────────────────────────

exports.adminSummary = async () => {
  await inventory.expireDue();
  const r = {
    role: ROLES.BLOOD_BANK,
    inStock: IN_STOCK,
    available: B.UNIT_STATUS.AVAILABLE,
    reserved: B.UNIT_STATUS.RESERVED,
    issued: B.UNIT_STATUS.ISSUED,
    gone: [B.UNIT_STATUS.EXPIRED, B.UNIT_STATUS.DISCARDED],
    expired: B.UNIT_STATUS.EXPIRED,
    discarded: B.UNIT_STATUS.DISCARDED,
    open: OPEN,
    allOpen: B.BLOOD_REQUEST_OPEN,
    scheduled: B.CAMP_STATUS.SCHEDULED,
    since: new Date(startOfToday().getTime() - (TREND_DAYS - 1) * 86400000),
  };
  const [[banks], [donors], [units], [requests], [camps], byGroup, byStatus, requestTrend, issueTrend] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(p.verification_status = 'approved' AND p.is_active = 1 AND u.is_active = 1), 0) AS active,
              COALESCE(SUM(p.verification_status = 'pending'), 0) AS pending,
              COALESCE(SUM(p.verification_status = 'rejected'), 0) AS rejected
         FROM users u LEFT JOIN blood_bank_profiles p ON p.user_id = u.id
        WHERE u.role = :role`,
      r
    ),
    select(`SELECT COUNT(*) AS total FROM blood_donors`),
    select(
      `SELECT COALESCE(SUM(status IN (:inStock)), 0) AS inStock,
              COALESCE(SUM(status = :available), 0) AS available,
              COALESCE(SUM(status = :reserved), 0) AS reserved,
              COALESCE(SUM(status = :issued), 0) AS issued,
              COALESCE(SUM(status = :expired), 0) AS expired,
              COALESCE(SUM(status = :discarded), 0) AS discarded
         FROM blood_units`,
      r
    ),
    select(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status IN (:open)), 0) AS pending,
              COALESCE(SUM(is_emergency = 1 AND status IN (:allOpen)), 0) AS emergencyOpen,
              COALESCE(SUM(is_emergency = 1), 0) AS emergencyTotal,
              COALESCE(SUM(status = 'completed'), 0) AS completed
         FROM blood_requests`,
      r
    ),
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = :scheduled AND camp_date >= CURDATE()), 0) AS upcoming FROM blood_camps`,
      r
    ),
    select(`SELECT blood_group AS bloodGroup, COUNT(*) AS n FROM blood_units WHERE status = :available GROUP BY blood_group`, r),
    select(`SELECT status, COUNT(*) AS n FROM blood_requests GROUP BY status`),
    select(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM blood_requests WHERE created_at >= :since GROUP BY day`,
      r
    ),
    select(
      `SELECT DATE_FORMAT(issued_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM blood_issues WHERE issued_at >= :since GROUP BY day`,
      r
    ),
  ]);
  const groupMap = new Map(byGroup.map((g) => [g.bloodGroup, num(g.n)]));
  const statusMap = new Map(byStatus.map((s) => [s.status, num(s.n)]));
  return {
    banks: { total: num(banks.total), active: num(banks.active), pending: num(banks.pending), rejected: num(banks.rejected) },
    donors: { total: num(donors.total) },
    units: {
      inStock: num(units.inStock),
      available: num(units.available),
      reserved: num(units.reserved),
      issued: num(units.issued),
      expired: num(units.expired),
      discarded: num(units.discarded),
    },
    requests: {
      total: num(requests.total),
      pending: num(requests.pending),
      emergencyOpen: num(requests.emergencyOpen),
      emergencyTotal: num(requests.emergencyTotal),
      completed: num(requests.completed),
      byStatus: Object.values(B.BLOOD_REQUEST_STATUS).map((s) => ({ status: s, count: statusMap.get(s) || 0 })),
    },
    camps: { total: num(camps.total), upcoming: num(camps.upcoming) },
    charts: {
      availableByGroup: B.BLOOD_GROUPS.map((g) => ({ bloodGroup: g, available: groupMap.get(g) || 0 })),
      requestTrend: series(requestTrend, TREND_DAYS),
      issueTrend: series(issueTrend, TREND_DAYS),
    },
  };
};

/** Per-bank inventory counts (no donor or patient data). */
exports.adminInventory = async ({ bloodBankId } = {}) => {
  await inventory.expireDue();
  const where = bloodBankId ? "AND u.blood_bank_id = :bank" : "";
  const rows = await select(
    `SELECT u.blood_bank_id AS bloodBankId, b.name AS bankName, b.city,
            u.blood_group AS bloodGroup, u.component,
            COALESCE(SUM(u.status = 'available'), 0) AS available,
            COALESCE(SUM(u.status = 'reserved'), 0) AS reserved,
            COALESCE(SUM(u.status IN ('quarantine','testing')), 0) AS inTesting
       FROM blood_units u JOIN users b ON b.id = u.blood_bank_id
      WHERE u.status IN (:inStock) ${where}
      GROUP BY u.blood_bank_id, b.name, b.city, u.blood_group, u.component
      ORDER BY b.name, u.blood_group, u.component`,
    { inStock: IN_STOCK, bank: bloodBankId }
  );
  return rows.map((x) => ({
    ...x,
    bloodBankId: String(x.bloodBankId),
    componentLabel: B.BLOOD_COMPONENTS[x.component]?.label || x.component,
    available: num(x.available),
    reserved: num(x.reserved),
    inTesting: num(x.inTesting),
  }));
};

/**
 * The admin's request ledger: workflow status and step times only — patient
 * name + hospital (needed for oversight), never the supporting document.
 */
exports.adminRequests = async ({ status, bloodBankId, emergency, bloodGroup, from, to, page = 1, limit = 20 } = {}) => {
  const clauses = [];
  const rep = { limit, offset: (page - 1) * limit };
  if (status) {
    clauses.push("r.status = :status");
    rep.status = status;
  }
  if (bloodBankId) {
    clauses.push("r.blood_bank_id = :bank");
    rep.bank = bloodBankId;
  }
  if (emergency !== undefined) {
    clauses.push("r.is_emergency = :em");
    rep.em = emergency ? 1 : 0;
  }
  if (bloodGroup) {
    clauses.push("r.blood_group = :bg");
    rep.bg = bloodGroup;
  }
  if (from) {
    clauses.push("r.created_at >= :from");
    rep.from = from;
  }
  if (to) {
    clauses.push("r.created_at < :to");
    rep.to = to;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [rows, [{ total }]] = await Promise.all([
    select(
      `SELECT r.id, r.request_code AS requestCode, r.status, r.is_emergency AS isEmergency, r.urgency,
              r.blood_group AS bloodGroup, r.component, r.units_required AS unitsRequired,
              r.patient_name AS patientName, r.hospital_name AS hospitalName,
              r.created_at AS createdAt, r.approved_at AS approvedAt, r.completed_at AS completedAt,
              b.id AS bloodBankId, b.name AS bankName, b.city AS bankCity,
              (SELECT COUNT(*) FROM blood_reservations x WHERE x.request_id = r.id AND x.status = 'active') AS reservedUnits,
              (SELECT COUNT(*) FROM blood_issues i WHERE i.request_id = r.id) AS issuedUnits
         FROM blood_requests r JOIN users b ON b.id = r.blood_bank_id
         ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT :limit OFFSET :offset`,
      rep
    ),
    select(`SELECT COUNT(*) AS total FROM blood_requests r ${where}`, rep),
  ]);
  return {
    requests: rows.map((x) => ({
      ...x,
      id: String(x.id),
      bloodBankId: String(x.bloodBankId),
      isEmergency: Boolean(num(x.isEmergency)),
      componentLabel: B.BLOOD_COMPONENTS[x.component]?.label || x.component,
      reservedUnits: num(x.reservedUnits),
      issuedUnits: num(x.issuedUnits),
    })),
    total: num(total),
    page,
    limit,
    totalPages: Math.ceil(num(total) / limit),
  };
};
