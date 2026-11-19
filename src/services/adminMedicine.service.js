/**
 * Admin pharmacy / medicine tracking — read-only aggregates over the EXISTING
 * medicine tables. Nothing here writes, and every number is a COUNT/SUM the
 * database computes; no list is loaded just to be counted in JS.
 *
 * What an "order" is. A checkout is a `medicine_order_groups` row (one patient,
 * one pharmacy, N lines in `medicine_orders`). Orders placed before groups
 * existed (migration 036) are single `medicine_orders` lines with a NULL
 * `order_group_id` — every existing reader treats those as one-line orders, so
 * this does too: ORDERS_SQL is the union of both, and nothing is double counted
 * (a grouped line is only ever reached through its group).
 *
 * Stock is per provider. It is reported per inventory row / per provider and
 * counted (in / out / low), never summed across providers into a global figure.
 */
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../models");
const {
  ROLES,
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  ALL_MEDICINE_PROVIDER_ROLES,
  MEDICINE_PROVIDER_TYPE_LABELS,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_PAYMENT_METHOD,
  ADMIN_MEDICINE_LOW_STOCK_THRESHOLD,
} = require("../config/constants");

/**
 * The two source tables were created with different collations
 * (medicine_order_groups: utf8mb4_unicode_ci, medicine_orders: 0900_ai_ci), and
 * MySQL refuses to UNION string columns across them — so the legacy branch's
 * strings are converted to the groups' collation. Read-side only; no DDL.
 */
const asGroupCollation = (column) => `CONVERT(${column} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;

/** Every order, grouped checkouts + legacy ungrouped lines, in one shape. */
const ORDERS_SQL = `
  SELECT g.id AS group_id, NULL AS line_id, g.order_number, g.patient_id, g.provider_id,
         g.provider_type, g.total_amount AS amount, g.item_count, g.payment_method,
         g.payment_status, g.status, g.created_at
    FROM medicine_order_groups g
  UNION ALL
  SELECT NULL, o.id, NULL, o.patient_id, o.provider_id,
         ${asGroupCollation("o.provider_type")}, o.total_price, 1, NULL,
         ${asGroupCollation("o.payment_status")}, ${asGroupCollation("o.status")}, o.created_at
    FROM medicine_orders o
   WHERE o.order_group_id IS NULL`;

const select = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

const num = (v) => Number(v || 0);
const money = (v) => Math.round(num(v) * 100) / 100;
const typeLabel = (role) => MEDICINE_PROVIDER_TYPE_LABELS[role] || role;
const like = (s) => `%${s}%`;

/** WHERE clause over the ORDERS_SQL alias `o` for the shared order filters. */
function orderWhere({ from, to, pharmacyId, providerType, medicine, orderStatus, paymentStatus, paymentMethod } = {}) {
  const clauses = [];
  const replacements = {};
  if (from) { clauses.push("o.created_at >= :from"); replacements.from = from; }
  if (to) { clauses.push("o.created_at < :to"); replacements.to = to; }
  if (pharmacyId) { clauses.push("o.provider_id = :pharmacyId"); replacements.pharmacyId = pharmacyId; }
  if (providerType) { clauses.push("o.provider_type = :providerType"); replacements.providerType = providerType; }
  if (orderStatus) { clauses.push("o.status = :orderStatus"); replacements.orderStatus = orderStatus; }
  if (paymentStatus) { clauses.push("o.payment_status = :paymentStatus"); replacements.paymentStatus = paymentStatus; }
  if (paymentMethod) { clauses.push("o.payment_method = :paymentMethod"); replacements.paymentMethod = paymentMethod; }
  if (medicine) {
    clauses.push(`EXISTS (
      SELECT 1 FROM medicine_orders mo
        JOIN medicine_store_medicines m ON m.id = mo.medicine_id
       WHERE ((o.group_id IS NOT NULL AND mo.order_group_id = o.group_id)
           OR (o.line_id IS NOT NULL AND mo.id = o.line_id))
         AND (m.medicine_name LIKE :medicine OR m.generic_name LIKE :medicine))`);
    replacements.medicine = like(medicine);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", replacements };
}

/** `{ pending: 0, confirmed: 0, … }` — every status present, even at zero. */
const zeroStatuses = () =>
  Object.fromEntries(Object.values(MEDICINE_ORDER_STATUS).map((s) => [s, 0]));

// ── Overview ──────────────────────────────────────────────────────────────

exports.overview = async (filters = {}) => {
  const w = orderWhere(filters);
  const roles = { roles: ALL_MEDICINE_PROVIDER_ROLES };

  const [
    [medicines],
    categories,
    providers,
    [orderTotals],
    byStatus,
    byPayment,
    attempts,
    pharmacyRows,
    pharmacyStatus,
    [inventory],
  ] = await Promise.all([
    select(`SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active FROM medicine_masters`),
    select(`
      SELECT c.id, c.name, COUNT(m.id) AS medicines
        FROM medicine_categories c
        LEFT JOIN medicine_masters m ON m.category_id = c.id
       GROUP BY c.id, c.name
       ORDER BY medicines DESC, c.name ASC`),
    select(
      `SELECT role, COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active
         FROM users WHERE role IN (:roles) GROUP BY role`,
      roles
    ),
    select(
      `SELECT COUNT(*) AS orders, COUNT(DISTINCT o.patient_id) AS patients,
              COALESCE(SUM(o.amount), 0) AS amount,
              COALESCE(SUM(CASE WHEN o.payment_status = :paid THEN o.amount END), 0) AS paidAmount
         FROM (${ORDERS_SQL}) o ${w.sql}`,
      { ...w.replacements, paid: MEDICINE_ORDER_PAYMENT_STATUS.PAID }
    ),
    select(
      `SELECT o.status, COUNT(*) AS n, COALESCE(SUM(o.amount), 0) AS amount
         FROM (${ORDERS_SQL}) o ${w.sql} GROUP BY o.status`,
      w.replacements
    ),
    select(
      `SELECT o.payment_method AS method, o.payment_status AS status,
              COUNT(*) AS n, COALESCE(SUM(o.amount), 0) AS amount
         FROM (${ORDERS_SQL}) o ${w.sql} GROUP BY o.payment_method, o.payment_status`,
      w.replacements
    ),
    // Payment ATTEMPTS (simulated gateway rows) — a failed online attempt that
    // was later retried shows here even though its order ended up paid.
    select(`SELECT method, status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
              FROM medicine_payments GROUP BY method, status`),
    select(
      `SELECT o.provider_id AS id, p.name, p.role, p.city, p.state,
              COUNT(*) AS orders, COUNT(DISTINCT o.patient_id) AS patients,
              COALESCE(SUM(o.amount), 0) AS amount
         FROM (${ORDERS_SQL}) o
         JOIN users p ON p.id = o.provider_id
         ${w.sql}
        GROUP BY o.provider_id, p.name, p.role, p.city, p.state
        ORDER BY orders DESC, p.name ASC`,
      w.replacements
    ),
    select(
      `SELECT o.provider_id AS id, o.status, COUNT(*) AS n
         FROM (${ORDERS_SQL}) o ${w.sql} GROUP BY o.provider_id, o.status`,
      w.replacements
    ),
    select(
      `SELECT COUNT(*) AS records,
              COUNT(DISTINCT medicine_master_id) AS medicines,
              COUNT(DISTINCT provider_id) AS providers,
              COALESCE(SUM(stock > 0), 0) AS inStock,
              COALESCE(SUM(stock = 0), 0) AS outOfStock,
              COALESCE(SUM(stock > 0 AND stock <= :low), 0) AS lowStock
         FROM medicine_store_medicines WHERE is_active = 1`,
      { low: ADMIN_MEDICINE_LOW_STOCK_THRESHOLD }
    ),
  ]);

  const providerByRole = new Map(providers.map((r) => [r.role, r]));
  const providerCount = (role) => {
    const r = providerByRole.get(role);
    const total = num(r?.total);
    const active = num(r?.active);
    return { role, label: typeLabel(role), total, active, inactive: total - active };
  };

  const ordersByStatus = zeroStatuses();
  byStatus.forEach((r) => { ordersByStatus[r.status] = num(r.n); });

  const statusByPharmacy = new Map();
  pharmacyStatus.forEach((r) => {
    const key = String(r.id);
    if (!statusByPharmacy.has(key)) statusByPharmacy.set(key, zeroStatuses());
    statusByPharmacy.get(key)[r.status] = num(r.n);
  });

  const paymentCount = (status) =>
    byPayment.filter((r) => r.status === status).reduce((sum, r) => sum + num(r.n), 0);
  const methodCount = (method) =>
    byPayment.filter((r) => r.method === method).reduce((sum, r) => sum + num(r.n), 0);

  return {
    medicines: {
      total: num(medicines.total),
      active: num(medicines.active),
      inactive: num(medicines.total) - num(medicines.active),
      byCategory: categories.map((c) => ({ id: c.id, name: c.name, medicines: num(c.medicines) })),
    },
    providers: {
      active: ACTIVE_MEDICINE_PROVIDER_ROLES.map(providerCount),
      /** Historical MR accounts — read-only visibility, never an active type. */
      legacyMr: providerCount(ROLES.MR),
    },
    orders: {
      total: num(orderTotals.orders),
      patients: num(orderTotals.patients),
      amount: money(orderTotals.amount),
      paidAmount: money(orderTotals.paidAmount),
      byStatus: ordersByStatus,
    },
    payments: {
      paid: paymentCount(MEDICINE_ORDER_PAYMENT_STATUS.PAID),
      pending: paymentCount(MEDICINE_ORDER_PAYMENT_STATUS.PENDING),
      failed: paymentCount(MEDICINE_ORDER_PAYMENT_STATUS.FAILED),
      refunded: paymentCount(MEDICINE_ORDER_PAYMENT_STATUS.REFUNDED),
      cod: methodCount(MEDICINE_PAYMENT_METHOD.COD),
      online: methodCount(MEDICINE_PAYMENT_METHOD.ONLINE),
      /** Paid to the pharmacy's own UPI QR (migration 044). */
      upiQr: methodCount(MEDICINE_PAYMENT_METHOD.UPI_QR),
      /** Legacy one-line orders placed before a payment method was recorded. */
      unspecifiedMethod: methodCount(null),
      breakdown: byPayment.map((r) => ({
        method: r.method,
        status: r.status,
        orders: num(r.n),
        amount: money(r.amount),
      })),
      attempts: attempts.map((r) => ({
        method: r.method,
        status: r.status,
        count: num(r.n),
        amount: money(r.amount),
      })),
    },
    pharmacies: pharmacyRows.map((r) => ({
      id: r.id,
      name: r.name,
      providerType: r.role,
      typeLabel: typeLabel(r.role),
      city: r.city,
      state: r.state,
      orders: num(r.orders),
      patients: num(r.patients),
      amount: money(r.amount),
      byStatus: statusByPharmacy.get(String(r.id)) || zeroStatuses(),
    })),
    inventory: {
      records: num(inventory.records),
      medicines: num(inventory.medicines),
      providers: num(inventory.providers),
      inStock: num(inventory.inStock),
      outOfStock: num(inventory.outOfStock),
      lowStock: num(inventory.lowStock),
      lowStockThreshold: ADMIN_MEDICINE_LOW_STOCK_THRESHOLD,
    },
  };
};

// ── Order tracking ────────────────────────────────────────────────────────

/**
 * Paged order list: patient → order → pharmacy → lines → amount → payment →
 * status. The patient is identified by id + name only — no contact details,
 * address or health data, which admin tracking does not need.
 */
exports.listOrders = async ({ page = 1, limit = 20, ...filters } = {}) => {
  const w = orderWhere(filters);
  const offset = (page - 1) * limit;

  const [[{ total }], rows] = await Promise.all([
    select(`SELECT COUNT(*) AS total FROM (${ORDERS_SQL}) o ${w.sql}`, w.replacements),
    select(
      `SELECT o.*, pt.name AS patient_name, p.name AS provider_name, p.role AS provider_role,
              p.city AS provider_city
         FROM (${ORDERS_SQL}) o
         LEFT JOIN users pt ON pt.id = o.patient_id
         LEFT JOIN users p  ON p.id  = o.provider_id
         ${w.sql}
        ORDER BY o.created_at DESC
        LIMIT :limit OFFSET :offset`,
      { ...w.replacements, limit, offset }
    ),
  ]);

  // Lines for THIS page only, in one query (no per-order lookups).
  const groupIds = rows.filter((r) => r.group_id != null).map((r) => r.group_id);
  const lineIds = rows.filter((r) => r.line_id != null).map((r) => r.line_id);
  const lines = rows.length
    ? await select(
        `SELECT mo.id, mo.order_group_id, mo.quantity, mo.unit_price, mo.total_price,
                m.medicine_name, m.strength, m.medicine_type
           FROM medicine_orders mo
           LEFT JOIN medicine_store_medicines m ON m.id = mo.medicine_id
          WHERE mo.order_group_id IN (:groupIds) OR mo.id IN (:lineIds)
          ORDER BY mo.id ASC`,
        // `IN ()` is invalid SQL; 0 matches no row (ids are auto-increment from 1).
        { groupIds: groupIds.length ? groupIds : [0], lineIds: lineIds.length ? lineIds : [0] }
      )
    : [];
  const linesFor = (r) =>
    lines
      .filter((l) => (r.group_id != null ? String(l.order_group_id) === String(r.group_id) : String(l.id) === String(r.line_id)))
      .map((l) => ({
        id: l.id,
        medicineName: l.medicine_name,
        strength: l.strength,
        medicineType: l.medicine_type,
        quantity: num(l.quantity),
        unitPrice: money(l.unit_price),
        totalPrice: money(l.total_price),
      }));

  const orders = rows.map((r) => ({
    key: r.group_id != null ? `g${r.group_id}` : `l${r.line_id}`,
    groupId: r.group_id,
    lineId: r.line_id,
    orderNumber: r.order_number,
    patient: { id: r.patient_id, name: r.patient_name },
    pharmacy: {
      id: r.provider_id,
      name: r.provider_name,
      providerType: r.provider_type,
      typeLabel: typeLabel(r.provider_type),
      city: r.provider_city,
    },
    items: linesFor(r),
    itemCount: num(r.item_count),
    amount: money(r.amount),
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    status: r.status,
    createdAt: r.created_at,
  }));

  const count = num(total);
  return { orders, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

// ── Inventory (medicine × provider) ───────────────────────────────────────

exports.listInventory = async ({ search, providerId, providerType, stock, page = 1, limit = 20 } = {}) => {
  const clauses = ["i.is_active = 1"];
  const replacements = { low: ADMIN_MEDICINE_LOW_STOCK_THRESHOLD };
  if (search) {
    clauses.push("(i.medicine_name LIKE :search OR i.generic_name LIKE :search OR i.manufacturer LIKE :search)");
    replacements.search = like(search);
  }
  if (providerId) { clauses.push("i.provider_id = :providerId"); replacements.providerId = providerId; }
  if (providerType) { clauses.push("p.role = :providerType"); replacements.providerType = providerType; }
  if (stock === "in") clauses.push("i.stock > 0");
  else if (stock === "out") clauses.push("i.stock = 0");
  else if (stock === "low") clauses.push("i.stock > 0 AND i.stock <= :low");
  const where = `WHERE ${clauses.join(" AND ")}`;
  const from = `FROM medicine_store_medicines i
                JOIN users p ON p.id = i.provider_id
                LEFT JOIN medicine_categories c ON c.id = i.category_id`;
  const offset = (page - 1) * limit;

  const [[{ total }], rows] = await Promise.all([
    select(`SELECT COUNT(*) AS total ${from} ${where}`, replacements),
    select(
      `SELECT i.id, i.medicine_master_id, i.medicine_name, i.generic_name, i.strength, i.medicine_type,
              i.manufacturer, i.price, i.stock, c.name AS category_name,
              p.id AS provider_id, p.name AS provider_name, p.role AS provider_role,
              p.city, p.state, p.is_active AS provider_active
         ${from} ${where}
        ORDER BY i.medicine_name ASC, i.price ASC
        LIMIT :limit OFFSET :offset`,
      { ...replacements, limit, offset }
    ),
  ]);

  const items = rows.map((r) => ({
    id: r.id,
    medicineMasterId: r.medicine_master_id,
    medicineName: r.medicine_name,
    genericName: r.generic_name,
    strength: r.strength,
    medicineType: r.medicine_type,
    manufacturer: r.manufacturer,
    category: r.category_name,
    price: money(r.price),
    stock: num(r.stock),
    stockState: num(r.stock) === 0 ? "out" : num(r.stock) <= ADMIN_MEDICINE_LOW_STOCK_THRESHOLD ? "low" : "in",
    provider: {
      id: r.provider_id,
      name: r.provider_name,
      providerType: r.provider_role,
      typeLabel: typeLabel(r.provider_role),
      city: r.city,
      state: r.state,
      isActive: Boolean(r.provider_active),
    },
  }));

  const count = num(total);
  return { items, total: count, page, limit, totalPages: Math.ceil(count / limit), lowStockThreshold: ADMIN_MEDICINE_LOW_STOCK_THRESHOLD };
};

// ── Pharmacy directory (filter options + provider-wise inventory counts) ──

exports.listPharmacies = async ({ providerType, search } = {}) => {
  const clauses = ["u.role IN (:roles)"];
  const replacements = { roles: providerType ? [providerType] : ALL_MEDICINE_PROVIDER_ROLES };
  if (search) { clauses.push("u.name LIKE :search"); replacements.search = like(search); }

  const rows = await select(
    `SELECT u.id, u.name, u.role, u.city, u.state, u.is_active,
            COUNT(i.id) AS inventory,
            COALESCE(SUM(i.stock = 0), 0) AS outOfStock
       FROM users u
       LEFT JOIN medicine_store_medicines i ON i.provider_id = u.id AND i.is_active = 1
      WHERE ${clauses.join(" AND ")}
      GROUP BY u.id, u.name, u.role, u.city, u.state, u.is_active
      ORDER BY u.name ASC`,
    replacements
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    providerType: r.role,
    typeLabel: typeLabel(r.role),
    isLegacy: !ACTIVE_MEDICINE_PROVIDER_ROLES.includes(r.role),
    city: r.city,
    state: r.state,
    isActive: Boolean(r.is_active),
    inventory: num(r.inventory),
    outOfStock: num(r.outOfStock),
  }));
};
