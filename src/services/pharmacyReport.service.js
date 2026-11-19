/**
 * Pharmacy dashboard + reports (migration 043). Every figure is aggregated
 * IN THE DATABASE from real rows — orders, order lines, purchases, batches,
 * credit notes — and scoped to the signed-in pharmacy. Nothing is sampled,
 * estimated or hard-coded; when a figure cannot be computed from what is
 * stored (e.g. a margin without a buying price) it is reported as such
 * instead of guessed.
 *
 * What counts as a SALE: an order of this pharmacy that is real to it (COD,
 * or paid / later refunded online) and not cancelled or rejected, dated by
 * when it was placed. Day boundaries are IST (utils/period), and the SQL
 * groups by IST day so week / month roll-ups are exact.
 *
 * "Gross margin" = net sale value excl. GST − buying cost of the units sold,
 * over lines whose cost was recorded. It is NOT net profit: rent, salaries
 * and other expenses are not in this system.
 */
const { QueryTypes } = require("sequelize");
const { sequelize, PrescriptionRequest, MedicineNotification } = require("../models");
const ApiError = require("../utils/ApiError");
const { money } = require("../utils/medicinePricing");
const { istToday, addDays, istDateRangeBounds, istDayBounds, bucketKey, zeroFill } = require("../utils/period");
const settingsService = require("./pharmacySettings.service");
const storeService = require("./medicineStore.service");
const inventoryService = require("./pharmacyInventory.service");
const purchaseService = require("./pharmacyPurchase.service");
const orderGroupService = require("./medicineOrderGroup.service");
const {
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_LIVE_ON_PLACE_METHODS,
  MEDICINE_ORDER_STATUS,
  PRESCRIPTION_REQUEST_STATUS,
} = require("../config/constants");
const { NON_SALE_ORDER_STATUSES, PURCHASE_STATUS, REPORT_MAX_RANGE_DAYS } = require("../config/pharmacy");

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const n = (v) => Number(v || 0);

/** SQL for "this order is a sale of :providerId" on medicine_order_groups alias g. */
const SALE_WHERE = `
  g.provider_id = :providerId
  AND (g.payment_method IN (:liveMethods) OR g.payment_status IN (:paidStatuses))
  AND g.status NOT IN (:nonSale)`;
/** The instant an order became a sale. */
const SALE_AT = "COALESCE(g.placed_at, g.created_at)";
/** IST calendar day of a UTC DATETIME column. */
const istDay = (column) => `DATE(CONVERT_TZ(${column}, '+00:00', '+05:30'))`;

const saleParams = (providerId) => ({
  providerId,
  // COD and UPI QR orders are sales from checkout (migration 044); online ones once paid.
  liveMethods: [...MEDICINE_LIVE_ON_PLACE_METHODS],
  paidStatuses: [MEDICINE_ORDER_PAYMENT_STATUS.PAID, MEDICINE_ORDER_PAYMENT_STATUS.REFUNDED],
  nonSale: NON_SALE_ORDER_STATUSES,
});

/**
 * Resolve a validated {from, to} (IST days, inclusive) — default: the last 30
 * days — and refuse ranges wider than REPORT_MAX_RANGE_DAYS so a report can
 * never scan all history at once.
 */
function resolveDays({ from, to } = {}) {
  const end = to || istToday();
  const start = from || addDays(end, -29);
  if (start > end) throw ApiError.badRequest("`from` must be on or before `to`");
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (span > REPORT_MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`A report can cover at most ${REPORT_MAX_RANGE_DAYS} days — narrow the date range`);
  }
  return { fromDay: start, toDay: end, ...istDateRangeBounds(start, end) };
}

/** Roll IST-day rows up into day / week / month buckets and zero-fill the gaps. */
function rollUp(dayRows, range, groupBy, fields) {
  const buckets = new Map();
  for (const row of dayRows) {
    const day = String(row.day instanceof Date ? row.day.toISOString() : row.day).slice(0, 10);
    const key = bucketKey(istDateRangeBounds(day, day).from, groupBy);
    const acc = buckets.get(key) || { bucket: key };
    for (const f of fields) acc[f] = (acc[f] || 0) + n(row[f]);
    buckets.set(key, acc);
  }
  const shape = Object.fromEntries(fields.map((f) => [f, 0]));
  return zeroFill([...buckets.values()], { from: range.from, to: range.to, granularity: groupBy, shape }).map((r) => {
    const out = { bucket: r.bucket };
    for (const f of fields) out[f] = f === "orders" || f === "purchases" || f === "units" ? n(r[f]) : money(r[f]);
    return out;
  });
}

// ── Inventory figures (dashboard + stock report) ─────────────────────────────

async function inventorySummary(providerId) {
  const today = istToday();
  const alertDays = await settingsService.expiryAlertDays(providerId);
  const [inv] = await select(
    `SELECT
       COUNT(*)                                                             AS totalMedicines,
       COALESCE(SUM(is_active = 1), 0)                                      AS activeMedicines,
       COALESCE(SUM(is_active = 1 AND stock = 0), 0)                        AS outOfStock,
       COALESCE(SUM(is_active = 1 AND stock > 0 AND stock <= min_stock), 0) AS lowStock,
       COALESCE(SUM(CASE WHEN is_active = 1 THEN stock END), 0)             AS totalUnits,
       COALESCE(SUM(CASE WHEN is_active = 1 AND buying_price IS NOT NULL THEN stock * buying_price END), 0) AS stockValueAtCost,
       COALESCE(SUM(is_active = 1 AND stock > 0 AND buying_price IS NULL), 0) AS itemsWithoutCost,
       COALESCE(SUM(CASE WHEN is_active = 1 THEN stock * ROUND(price * (1 - discount_percent / 100), 2) END), 0) AS stockValueAtSale
     FROM medicine_store_medicines
     WHERE provider_id = :providerId`,
    { providerId }
  );
  const [batches] = await select(
    `SELECT
       COALESCE(SUM(b.expiry_date < :today), 0)                                             AS expiredBatches,
       COALESCE(SUM(CASE WHEN b.expiry_date < :today THEN b.quantity_available END), 0)     AS expiredUnits,
       COALESCE(SUM(b.expiry_date >= :today AND b.expiry_date <= :horizon), 0)              AS expiringBatches,
       COALESCE(SUM(CASE WHEN b.expiry_date >= :today AND b.expiry_date <= :horizon THEN b.quantity_available END), 0) AS expiringUnits
     FROM medicine_stock_batches b
     JOIN medicine_store_medicines i ON i.id = b.inventory_id AND i.is_active = 1
     WHERE b.provider_id = :providerId AND b.quantity_available > 0`,
    { providerId, today, horizon: addDays(today, alertDays) }
  );
  return {
    totalMedicines: n(inv.totalMedicines),
    activeMedicines: n(inv.activeMedicines),
    outOfStock: n(inv.outOfStock),
    lowStock: n(inv.lowStock),
    totalUnits: n(inv.totalUnits),
    /** Σ stock × buying price, over items whose buying price is recorded. */
    stockValueAtCost: money(inv.stockValueAtCost),
    /** In-stock items with no buying price — not counted in the cost value. */
    itemsWithoutCost: n(inv.itemsWithoutCost),
    /** Σ stock × current effective selling price (after item discount, GST incl.). */
    stockValueAtSale: money(inv.stockValueAtSale),
    expiredBatches: n(batches.expiredBatches),
    expiredUnits: n(batches.expiredUnits),
    expiringBatches: n(batches.expiringBatches),
    expiringUnits: n(batches.expiringUnits),
    expiryAlertDays: alertDays,
  };
}

// ── Dashboard ────────────────────────────────────────────────────────────────

exports.dashboard = async (providerId) => {
  const todayBounds = istDayBounds();
  const params = saleParams(providerId);

  const [inventory, [today], [pending], pendingPrescriptions, unreadNotifications, recentOrders, recentPurchases, lowStock, expiring] =
    await Promise.all([
      inventorySummary(providerId),
      select(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(g.total_amount), 0) AS sales
           FROM medicine_order_groups g
          WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to`,
        { ...params, ...todayBounds }
      ),
      select(
        `SELECT COUNT(*) AS pending FROM medicine_order_groups g
          WHERE g.provider_id = :providerId AND g.status = :pendingStatus
            AND (g.payment_method IN (:liveMethods) OR g.payment_status IN (:paidStatuses))`,
        { ...params, pendingStatus: MEDICINE_ORDER_STATUS.PENDING }
      ),
      PrescriptionRequest.count({
        where: { providerId, status: [PRESCRIPTION_REQUEST_STATUS.PENDING, PRESCRIPTION_REQUEST_STATUS.VIEWED] },
      }),
      MedicineNotification.count({ where: { userId: providerId, isRead: false } }),
      orderGroupService.getProviderGroups(providerId, { page: 1, limit: 5 }),
      purchaseService.recent(providerId, 5),
      storeService.listMyMedicines(providerId, { stockStatus: "low", sort: "stock", order: "asc", page: 1, limit: 5 }),
      inventoryService.listBatches(providerId, { status: "expiring", page: 1, limit: 5 }),
    ]);

  return {
    cards: {
      ...inventory,
      todayOrders: n(today.orders),
      todaySales: money(today.sales),
      pendingOrders: n(pending.pending),
      pendingPrescriptions,
      unreadNotifications,
    },
    recentOrders: recentOrders.orders,
    recentPurchases,
    lowStockMedicines: lowStock.medicines,
    expiringBatches: expiring.batches,
  };
};

// ── Sales ────────────────────────────────────────────────────────────────────

const SALES_FIELDS = ["orders", "gross", "discount", "net", "taxable", "gst", "refunds"];

exports.sales = async (providerId, query) => {
  const range = resolveDays(query);
  const groupBy = query.groupBy || "day";
  const params = { ...saleParams(providerId), from: range.from, to: range.to };

  const [days, refundDays, byStatus, margin] = await Promise.all([
    select(
      `SELECT ${istDay(SALE_AT)} AS day,
              COUNT(*) AS orders,
              SUM(g.subtotal) AS gross,
              SUM(g.discount_total) AS discount,
              SUM(g.total_amount) AS net,
              SUM(COALESCE(g.taxable_total, 0)) AS taxable,
              SUM(g.gst_total) AS gst
         FROM medicine_order_groups g
        WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to
        GROUP BY day`,
      params
    ),
    select(
      `SELECT ${istDay("r.created_at")} AS day, SUM(r.refund_amount) AS refunds
         FROM medicine_returns r
        WHERE r.provider_id = :providerId AND r.created_at >= :from AND r.created_at < :to
        GROUP BY day`,
      params
    ),
    select(
      `SELECT g.status, g.payment_status AS paymentStatus, g.payment_method AS paymentMethod,
              COUNT(*) AS orders, SUM(g.total_amount) AS amount
         FROM medicine_order_groups g
        WHERE g.provider_id = :providerId
          AND (g.payment_method IN (:liveMethods) OR g.payment_status IN (:paidStatuses))
          AND ${SALE_AT} >= :from AND ${SALE_AT} < :to
        GROUP BY g.status, g.payment_status, g.payment_method`,
      params
    ),
    select(
      `SELECT COUNT(*) AS lineCount,
              COALESCE(SUM(o.unit_cost IS NOT NULL), 0) AS costedLines,
              COALESCE(SUM(CASE WHEN o.unit_cost IS NOT NULL THEN COALESCE(o.taxable_amount, o.total_price) END), 0) AS revenueExGst,
              COALESCE(SUM(CASE WHEN o.unit_cost IS NOT NULL THEN o.unit_cost * o.quantity END), 0) AS cost
         FROM medicine_orders o
         JOIN medicine_order_groups g ON g.id = o.order_group_id
        WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to`,
      params
    ),
  ]);

  const merged = new Map();
  for (const row of days) merged.set(String(row.day), { ...row });
  for (const row of refundDays) merged.set(String(row.day), { ...(merged.get(String(row.day)) || { day: row.day }), refunds: row.refunds });
  const series = rollUp([...merged.values()], range, groupBy, SALES_FIELDS);

  const totals = Object.fromEntries(SALES_FIELDS.map((f) => [f, f === "orders" ? series.reduce((a, r) => a + r[f], 0) : money(series.reduce((a, r) => a + r[f], 0))]));
  totals.netAfterRefunds = money(totals.net - totals.refunds);
  totals.averageOrderValue = totals.orders ? money(totals.net / totals.orders) : 0;

  const breakdown = (key) => {
    const map = new Map();
    for (const row of byStatus) {
      const k = row[key];
      const acc = map.get(k) || { [key]: k, orders: 0, amount: 0 };
      acc.orders += n(row.orders);
      acc.amount = money(acc.amount + n(row.amount));
      map.set(k, acc);
    }
    return [...map.values()];
  };

  const m = margin[0];
  const revenueExGst = money(m.revenueExGst);
  const cost = money(m.cost);
  return {
    from: range.fromDay,
    to: range.toDay,
    groupBy,
    series,
    totals,
    byOrderStatus: breakdown("status"),
    byPaymentStatus: breakdown("paymentStatus"),
    byPaymentMethod: breakdown("paymentMethod"),
    grossMargin: {
      revenueExGst,
      cost,
      grossMargin: money(revenueExGst - cost),
      marginPercent: revenueExGst > 0 ? money(((revenueExGst - cost) / revenueExGst) * 100) : null,
      costedLines: n(m.costedLines),
      totalLines: n(m.lineCount),
      note: "Gross margin over sold lines whose buying price was recorded. Expenses are not tracked, so this is not net profit.",
    },
  };
};

exports.topMedicines = async (providerId, query) => {
  const range = resolveDays(query);
  const rows = await select(
    `SELECT o.medicine_id AS medicineId,
            i.medicine_name AS medicineName, i.strength, i.medicine_type AS medicineType,
            SUM(o.quantity) AS units,
            SUM(o.total_price) AS revenue,
            COUNT(DISTINCT g.id) AS orders,
            SUM(CASE WHEN o.unit_cost IS NOT NULL THEN COALESCE(o.taxable_amount, o.total_price) - o.unit_cost * o.quantity END) AS grossMargin
       FROM medicine_orders o
       JOIN medicine_order_groups g ON g.id = o.order_group_id
       LEFT JOIN medicine_store_medicines i ON i.id = o.medicine_id
      WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to
      GROUP BY o.medicine_id, i.medicine_name, i.strength, i.medicine_type
      ORDER BY units DESC, revenue DESC
      LIMIT :limit`,
    { ...saleParams(providerId), from: range.from, to: range.to, limit: query.limit || 10 }
  );
  return {
    from: range.fromDay,
    to: range.toDay,
    medicines: rows.map((r) => ({
      medicineId: Number(r.medicineId),
      medicineName: r.medicineName,
      strength: r.strength,
      medicineType: r.medicineType,
      units: n(r.units),
      orders: n(r.orders),
      revenue: money(r.revenue),
      grossMargin: r.grossMargin === null ? null : money(r.grossMargin),
    })),
  };
};

// ── Purchases ────────────────────────────────────────────────────────────────

const PURCHASE_FIELDS = ["purchases", "gross", "discount", "taxable", "gst", "total"];

exports.purchases = async (providerId, query) => {
  const range = resolveDays(query);
  const groupBy = query.groupBy || "day";
  const params = { providerId, received: PURCHASE_STATUS.RECEIVED, fromDay: range.fromDay, toDay: range.toDay };

  const [days, suppliers] = await Promise.all([
    select(
      `SELECT p.invoice_date AS day, COUNT(*) AS purchases, SUM(p.subtotal) AS gross, SUM(p.discount_total) AS discount,
              SUM(p.taxable_total) AS taxable, SUM(p.gst_total) AS gst, SUM(p.total_amount) AS total
         FROM pharmacy_purchases p
        WHERE p.provider_id = :providerId AND p.status = :received AND p.invoice_date BETWEEN :fromDay AND :toDay
        GROUP BY p.invoice_date`,
      params
    ),
    select(
      `SELECT p.supplier_id AS supplierId, s.name AS supplierName, COUNT(*) AS purchases, SUM(p.total_amount) AS total
         FROM pharmacy_purchases p
         LEFT JOIN pharmacy_suppliers s ON s.id = p.supplier_id
        WHERE p.provider_id = :providerId AND p.status = :received AND p.invoice_date BETWEEN :fromDay AND :toDay
        GROUP BY p.supplier_id, s.name
        ORDER BY total DESC`,
      params
    ),
  ]);
  const series = rollUp(days, range, groupBy, PURCHASE_FIELDS);
  const totals = Object.fromEntries(
    PURCHASE_FIELDS.map((f) => [f, f === "purchases" ? series.reduce((a, r) => a + r[f], 0) : money(series.reduce((a, r) => a + r[f], 0))])
  );
  return {
    from: range.fromDay,
    to: range.toDay,
    groupBy,
    series,
    totals,
    bySupplier: suppliers.map((s) => ({
      supplierId: s.supplierId ? Number(s.supplierId) : null,
      supplierName: s.supplierName || "No supplier",
      purchases: n(s.purchases),
      total: money(s.total),
    })),
  };
};

// ── GST ──────────────────────────────────────────────────────────────────────

/**
 * GST by rate for a period: tax INCLUDED in sales (output), tax reversed by
 * credit notes, and tax PAID on purchases (input). Sale lines placed before
 * GST data was recorded are counted separately, never assigned a rate.
 */
exports.gst = async (providerId, query) => {
  const range = resolveDays(query);
  const params = { ...saleParams(providerId), from: range.from, to: range.to, received: PURCHASE_STATUS.RECEIVED, fromDay: range.fromDay, toDay: range.toDay };

  const [output, untaxed, returns, input] = await Promise.all([
    select(
      `SELECT o.gst_rate AS gstRate, SUM(o.taxable_amount) AS taxable, SUM(o.gst_amount) AS gst, SUM(o.total_price) AS gross
         FROM medicine_orders o JOIN medicine_order_groups g ON g.id = o.order_group_id
        WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to AND o.taxable_amount IS NOT NULL
        GROUP BY o.gst_rate ORDER BY o.gst_rate`,
      params
    ),
    select(
      `SELECT COUNT(*) AS lineCount, COALESCE(SUM(o.total_price), 0) AS amount
         FROM medicine_orders o JOIN medicine_order_groups g ON g.id = o.order_group_id
        WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to AND o.taxable_amount IS NULL`,
      params
    ),
    select(
      `SELECT ri.gst_rate AS gstRate, SUM(ri.taxable_amount) AS taxable, SUM(ri.gst_amount) AS gst
         FROM medicine_return_items ri JOIN medicine_returns r ON r.id = ri.return_id
        WHERE r.provider_id = :providerId AND r.created_at >= :from AND r.created_at < :to
        GROUP BY ri.gst_rate ORDER BY ri.gst_rate`,
      params
    ),
    select(
      `SELECT pi.gst_rate AS gstRate, SUM(pi.taxable_amount) AS taxable, SUM(pi.gst_amount) AS gst
         FROM pharmacy_purchase_items pi JOIN pharmacy_purchases p ON p.id = pi.purchase_id
        WHERE p.provider_id = :providerId AND p.status = :received AND p.invoice_date BETWEEN :fromDay AND :toDay
        GROUP BY pi.gst_rate ORDER BY pi.gst_rate`,
      params
    ),
  ]);

  const shape = (rows) => rows.map((r) => ({ gstRate: Number(r.gstRate), taxable: money(r.taxable), gst: money(r.gst) }));
  const sum = (rows, key) => money(rows.reduce((a, r) => a + n(r[key]), 0));
  const outputTax = sum(output, "gst");
  const returnTax = sum(returns, "gst");
  const inputTax = sum(input, "gst");
  return {
    from: range.fromDay,
    to: range.toDay,
    output: shape(output),
    returns: shape(returns),
    input: shape(input),
    totals: {
      outputTaxable: sum(output, "taxable"),
      outputGst: outputTax,
      returnTaxable: sum(returns, "taxable"),
      returnGst: returnTax,
      inputTaxable: sum(input, "taxable"),
      inputGst: inputTax,
      /** Output − credit notes − input. Indicative only — not a GST return. */
      netGst: money(outputTax - returnTax - inputTax),
    },
    linesWithoutGstData: { lines: n(untaxed[0].lineCount), amount: money(untaxed[0].amount) },
    note: "Selling prices include GST, so output GST is the tax contained in sales. Figures are indicative and are not a GST return.",
  };
};

// ── Stock ────────────────────────────────────────────────────────────────────

exports.stock = async (providerId) => {
  const [summary, byCategory] = await Promise.all([
    inventorySummary(providerId),
    select(
      `SELECT c.id AS categoryId, COALESCE(c.name, 'Uncategorised') AS category,
              COUNT(*) AS medicines, SUM(i.stock) AS units,
              SUM(i.stock = 0) AS outOfStock, SUM(i.stock > 0 AND i.stock <= i.min_stock) AS lowStock,
              SUM(CASE WHEN i.buying_price IS NOT NULL THEN i.stock * i.buying_price END) AS valueAtCost,
              SUM(i.stock * ROUND(i.price * (1 - i.discount_percent / 100), 2)) AS valueAtSale
         FROM medicine_store_medicines i
         LEFT JOIN medicine_categories c ON c.id = i.category_id
        WHERE i.provider_id = :providerId AND i.is_active = 1
        GROUP BY c.id, c.name
        ORDER BY valueAtSale DESC`,
      { providerId }
    ),
  ]);
  return {
    summary,
    byCategory: byCategory.map((r) => ({
      categoryId: r.categoryId ? Number(r.categoryId) : null,
      category: r.category,
      medicines: n(r.medicines),
      units: n(r.units),
      outOfStock: n(r.outOfStock),
      lowStock: n(r.lowStock),
      valueAtCost: money(r.valueAtCost),
      valueAtSale: money(r.valueAtSale),
    })),
  };
};

// ── Dashboard analytics (one request feeds every chart) ─────────────────────

/** Fast / slow movers are judged over this many trailing days (returned to the UI so it can say so). */
const MOVER_WINDOW_DAYS = 90;
const EXPIRY_BUCKETS = Object.freeze([
  { key: "d30", label: "Within 30 days", from: 0, to: 30 },
  { key: "d60", label: "31-60 days", from: 31, to: 60 },
  { key: "d90", label: "61-90 days", from: 61, to: 90 },
  { key: "later", label: "Over 90 days", from: 91, to: null },
]);

/** Count + net sales of this pharmacy's SALES inside a half-open UTC range. */
async function salesTotals(providerId, bounds) {
  const [row] = await select(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(g.total_amount), 0) AS net
       FROM medicine_order_groups g
      WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to`,
    { ...saleParams(providerId), ...bounds }
  );
  return { orders: n(row.orders), net: money(row.net) };
}

async function purchaseTotals(providerId, fromDay, toDay) {
  const [row] = await select(
    `SELECT COUNT(*) AS purchases, COALESCE(SUM(total_amount), 0) AS total
       FROM pharmacy_purchases
      WHERE provider_id = :providerId AND status = :received AND invoice_date BETWEEN :fromDay AND :toDay`,
    { providerId, received: PURCHASE_STATUS.RECEIVED, fromDay, toDay }
  );
  return { purchases: n(row.purchases), total: money(row.total) };
}

/** Batches with stock, bucketed by days to expiry. Expired stock is its own bucket, never "available". */
async function expiryAnalysis(providerId, today) {
  const cols = [
    "COALESCE(SUM(b.expiry_date < :today), 0) AS expiredBatches",
    "COALESCE(SUM(CASE WHEN b.expiry_date < :today THEN b.quantity_available END), 0) AS expiredUnits",
  ];
  const replacements = { providerId, today };
  for (const k of EXPIRY_BUCKETS) {
    replacements[`${k.key}Lo`] = addDays(today, k.from);
    let cond = `b.expiry_date >= :${k.key}Lo`;
    if (k.to !== null) {
      replacements[`${k.key}Hi`] = addDays(today, k.to);
      cond += ` AND b.expiry_date <= :${k.key}Hi`;
    }
    cols.push(`COALESCE(SUM(${cond}), 0) AS ${k.key}Batches`, `COALESCE(SUM(CASE WHEN ${cond} THEN b.quantity_available END), 0) AS ${k.key}Units`);
  }
  const [r] = await select(
    `SELECT ${cols.join(", ")}
       FROM medicine_stock_batches b
       JOIN medicine_store_medicines i ON i.id = b.inventory_id AND i.is_active = 1
      WHERE b.provider_id = :providerId AND b.quantity_available > 0`,
    replacements
  );
  return [
    { key: "expired", label: "Expired", batches: n(r.expiredBatches), units: n(r.expiredUnits) },
    ...EXPIRY_BUCKETS.map((k) => ({ key: k.key, label: k.label, batches: n(r[`${k.key}Batches`]), units: n(r[`${k.key}Units`]) })),
  ];
}

async function movers(providerId) {
  const today = istToday();
  const bounds = istDateRangeBounds(addDays(today, -(MOVER_WINDOW_DAYS - 1)), today);
  const sold = `(SELECT o.medicine_id AS medicineId, SUM(o.quantity) AS units
                   FROM medicine_orders o JOIN medicine_order_groups g ON g.id = o.order_group_id
                  WHERE ${SALE_WHERE} AND ${SALE_AT} >= :from AND ${SALE_AT} < :to
                  GROUP BY o.medicine_id) s`;
  const params = { ...saleParams(providerId), ...bounds };
  const [fast, slow, [nonMoving]] = await Promise.all([
    select(
      `SELECT i.id, i.medicine_name AS medicineName, i.strength, i.stock, i.min_stock AS minStock, s.units
         FROM medicine_store_medicines i JOIN ${sold} ON s.medicineId = i.id
        WHERE i.provider_id = :providerId AND i.is_active = 1
        ORDER BY s.units DESC LIMIT 5`,
      params
    ),
    select(
      `SELECT i.id, i.medicine_name AS medicineName, i.strength, i.stock,
              i.stock * ROUND(i.price * (1 - i.discount_percent / 100), 2) AS valueAtSale
         FROM medicine_store_medicines i LEFT JOIN ${sold} ON s.medicineId = i.id
        WHERE i.provider_id = :providerId AND i.is_active = 1 AND i.stock > 0 AND s.units IS NULL
        ORDER BY valueAtSale DESC LIMIT 5`,
      params
    ),
    select(
      `SELECT COUNT(*) AS items, COALESCE(SUM(i.stock * ROUND(i.price * (1 - i.discount_percent / 100), 2)), 0) AS valueAtSale
         FROM medicine_store_medicines i LEFT JOIN ${sold} ON s.medicineId = i.id
        WHERE i.provider_id = :providerId AND i.is_active = 1 AND i.stock > 0 AND s.units IS NULL`,
      params
    ),
  ]);
  return {
    windowDays: MOVER_WINDOW_DAYS,
    fast: fast.map((r) => {
      const perDay = n(r.units) / MOVER_WINDOW_DAYS;
      return {
        id: Number(r.id),
        medicineName: r.medicineName,
        strength: r.strength,
        units: n(r.units),
        stock: n(r.stock),
        minStock: n(r.minStock),
        daysOfCover: perDay > 0 ? Math.floor(n(r.stock) / perDay) : null,
        reorderSuggested: n(r.stock) <= n(r.minStock),
      };
    }),
    slow: slow.map((r) => ({ id: Number(r.id), medicineName: r.medicineName, strength: r.strength, stock: n(r.stock), valueAtSale: money(r.valueAtSale) })),
    nonMoving: { items: n(nonMoving.items), valueAtSale: money(nonMoving.valueAtSale) },
  };
}

async function recentMovements(providerId) {
  const rows = await select(
    `SELECT m.id, m.movement_type AS movementType, m.quantity, m.stock_after AS stockAfter,
            m.reference_type AS referenceType, m.reference_id AS referenceId, m.created_at AS createdAt,
            m.inventory_id AS inventoryId, i.medicine_name AS medicineName, i.strength, b.batch_number AS batchNumber
       FROM medicine_stock_movements m
       LEFT JOIN medicine_store_medicines i ON i.id = m.inventory_id
       LEFT JOIN medicine_stock_batches b ON b.id = m.batch_id
      WHERE m.provider_id = :providerId
      ORDER BY m.created_at DESC, m.id DESC LIMIT 8`,
    { providerId }
  );
  return rows.map((r) => ({
    id: Number(r.id),
    movementType: r.movementType,
    quantity: n(r.quantity),
    stockAfter: n(r.stockAfter),
    referenceType: r.referenceType,
    referenceId: r.referenceId ? Number(r.referenceId) : null,
    createdAt: r.createdAt,
    inventoryId: Number(r.inventoryId),
    medicineName: r.medicineName,
    strength: r.strength,
    batchNumber: r.batchNumber,
  }));
}

/** Live orders (COD / UPI-QR) not cancelled or rejected whose payment the pharmacy has not yet confirmed. */
async function unconfirmedPayments(providerId) {
  const [r] = await select(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(g.total_amount), 0) AS amount
       FROM medicine_order_groups g
      WHERE g.provider_id = :providerId AND g.payment_method IN (:liveMethods)
        AND g.payment_status = :pendingPay AND g.status NOT IN (:nonSale)`,
    { ...saleParams(providerId), pendingPay: MEDICINE_ORDER_PAYMENT_STATUS.PENDING }
  );
  return { orders: n(r.orders), amount: money(r.amount) };
}

exports.analytics = async (providerId, query) => {
  const range = resolveDays(query);
  const groupBy = query.groupBy || "day";
  const today = istToday();
  const monthStartDay = `${today.slice(0, 8)}01`;
  const span = (Date.parse(`${range.toDay}T00:00:00Z`) - Date.parse(`${range.fromDay}T00:00:00Z`)) / 86400000 + 1;
  const prevTo = addDays(range.fromDay, -1);
  const prevFrom = addDays(prevTo, -(span - 1));

  const [sales, purchases, top, expiry, mv, movements, unconfirmed, prev, month, purchaseToday, purchaseMonth, inventory] = await Promise.all([
    exports.sales(providerId, { from: range.fromDay, to: range.toDay, groupBy }),
    exports.purchases(providerId, { from: range.fromDay, to: range.toDay, groupBy }),
    exports.topMedicines(providerId, { from: range.fromDay, to: range.toDay, limit: 5 }),
    expiryAnalysis(providerId, today),
    movers(providerId),
    recentMovements(providerId),
    unconfirmedPayments(providerId),
    salesTotals(providerId, istDateRangeBounds(prevFrom, prevTo)),
    salesTotals(providerId, istDateRangeBounds(monthStartDay, today)),
    purchaseTotals(providerId, today, today),
    purchaseTotals(providerId, monthStartDay, today),
    inventorySummary(providerId),
  ]);

  return {
    range: { from: range.fromDay, to: range.toDay, groupBy, previousFrom: prevFrom, previousTo: prevTo },
    sales: {
      series: sales.series,
      totals: sales.totals,
      previous: prev,
      thisMonth: month,
      byPaymentMethod: sales.byPaymentMethod,
      byPaymentStatus: sales.byPaymentStatus,
      byOrderStatus: sales.byOrderStatus,
      grossMargin: sales.grossMargin,
      unconfirmedPayments: unconfirmed,
    },
    purchases: {
      series: purchases.series,
      totals: purchases.totals,
      today: purchaseToday,
      thisMonth: purchaseMonth,
      bySupplier: purchases.bySupplier.slice(0, 5),
    },
    topMedicines: top.medicines,
    movers: mv,
    inventoryHealth: {
      healthy: Math.max(inventory.activeMedicines - inventory.outOfStock - inventory.lowStock, 0),
      low: inventory.lowStock,
      out: inventory.outOfStock,
      activeMedicines: inventory.activeMedicines,
    },
    expiry,
    recentStockMovements: movements,
    expiryAlertDays: inventory.expiryAlertDays,
    /** Figures the data model cannot supply. The UI shows "Not tracked" for them and never a guess. */
    notTracked: ["supplierOutstanding", "customerCredit", "purchaseReturns", "operatingExpenses", "netProfit", "quarantinedStock", "branches"],
  };
};

exports.inventorySummary = inventorySummary;
