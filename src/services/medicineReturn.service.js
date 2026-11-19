/**
 * Returns against delivered medicine orders, and the credit notes they
 * produce (migration 043). Built on the EXISTING order: a return points at
 * the order group (the bill) and at its lines; it never creates a second
 * order or a second bill.
 *
 *   delivered order → returned quantity per line → refund = the returned
 *   share of what that line was ACTUALLY charged (after discount, GST
 *   included) → credit note CN-… → units back on the exact batches they left
 *   (when restocked) → patient notified
 *
 * Money is never accepted from the client. The last return on a line takes
 * whatever of the line is left, so the credit notes of a fully returned line
 * add up to its charged amount to the paisa.
 *
 * The refund itself is recorded, not paid out: payments are simulated / COD
 * on this platform, so the credit note is the record of what is owed back.
 */
const { Op, fn, col } = require("sequelize");
const {
  sequelize,
  MedicineReturn,
  MedicineReturnItem,
  MedicineOrderGroup,
  MedicineOrder,
  MedicineNotification,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const { toPaise, fromPaise, money, gstBreakup } = require("../utils/medicinePricing");
const { documentNumber } = require("../utils/documentNumber");
const { istDateRangeBounds } = require("../utils/period");
const stockService = require("./pharmacyStock.service");
const settingsService = require("./pharmacySettings.service");
const { ERROR_CODES, MEDICINE_ORDER_PAYMENT_STATUS } = require("../config/constants");
const { RETURNABLE_ORDER_STATUSES, STOCK_MOVEMENT_TYPE, DOCUMENT_PREFIX } = require("../config/pharmacy");

function serialize(row) {
  const r = row.toJSON ? row.toJSON() : row;
  return {
    id: Number(r.id),
    creditNoteNumber: r.creditNoteNumber,
    orderGroupId: Number(r.orderGroupId),
    orderNumber: r.group?.orderNumber ?? null,
    providerId: Number(r.providerId),
    patient: r.patient ? { id: Number(r.patient.id), name: r.patient.name, phone: r.patient.phone } : null,
    reason: r.reason,
    restocked: !!r.restocked,
    itemCount: r.itemCount,
    taxableTotal: money(r.taxableTotal),
    gstTotal: money(r.gstTotal),
    refundAmount: money(r.refundAmount),
    createdAt: r.createdAt,
    items: (r.items || []).map((i) => ({
      id: Number(i.id),
      orderLineId: Number(i.orderLineId),
      medicineId: i.medicineId ? Number(i.medicineId) : null,
      medicineName: i.medicineName,
      quantity: i.quantity,
      unitPrice: money(i.unitPrice),
      gstRate: Number(i.gstRate),
      taxableAmount: money(i.taxableAmount),
      gstAmount: money(i.gstAmount),
      lineTotal: money(i.lineTotal),
    })),
  };
}

const RETURN_INCLUDE = [
  { model: MedicineReturnItem, as: "items" },
  { model: MedicineOrderGroup, as: "group", attributes: ["id", "orderNumber", "paymentMethod", "paymentStatus"] },
  { model: User, as: "patient", attributes: ["id", "name", "phone"] },
];

/** What was already returned per order line: quantity, refund and GST, in one grouped query. */
async function returnedSoFar(lineIds, transaction) {
  if (!lineIds.length) return new Map();
  const rows = await MedicineReturnItem.findAll({
    where: { orderLineId: { [Op.in]: lineIds } },
    attributes: [
      "orderLineId",
      [fn("SUM", col("quantity")), "quantity"],
      [fn("SUM", col("line_total")), "lineTotal"],
      [fn("SUM", col("gst_amount")), "gstAmount"],
    ],
    group: ["orderLineId"],
    raw: true,
    transaction,
  });
  return new Map(rows.map((r) => [String(r.orderLineId), { quantity: Number(r.quantity), lineTotal: toPaise(r.lineTotal), gstAmount: toPaise(r.gstAmount) }]));
}

/**
 * The returned share of a line: proportional to the quantity, except that the
 * return which brings the line to fully-returned takes exactly what is left.
 */
function shareOf(line, quantity, already) {
  const isLast = already.quantity + quantity === line.quantity;
  const total = toPaise(line.totalPrice);
  const gst = toPaise(line.gstAmount);
  const lineTotal = isLast ? total - already.lineTotal : Math.round((total * quantity) / line.quantity);
  const gstAmount = isLast ? gst - already.gstAmount : Math.round((gst * quantity) / line.quantity);
  return {
    unitPrice: fromPaise(Math.round(total / line.quantity)),
    lineTotal: fromPaise(lineTotal),
    gstAmount: fromPaise(gstAmount),
    taxableAmount: fromPaise(lineTotal - gstAmount),
  };
}

/**
 * Record a return on one of the pharmacy's delivered orders.
 *
 * @param {number} providerId  the signed-in pharmacy (must own the order)
 * @param {number|string} groupId
 * @param {{items: Array<{orderLineId, quantity}>, reason?: string, restock?: boolean}} dto
 */
exports.create = async (providerId, groupId, dto, userId = providerId) => {
  const returnId = await sequelize.transaction(async (transaction) => {
    const group = await MedicineOrderGroup.findOne({
      where: { id: groupId, providerId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!group) throw ApiError.notFound("Order not found");
    if (!RETURNABLE_ORDER_STATUSES.includes(group.status)) {
      throw ApiError.badRequest("Only a delivered order can be returned", { code: ERROR_CODES.INVALID_STATUS_TRANSITION });
    }

    const lines = await MedicineOrder.findAll({ where: { orderGroupId: group.id }, transaction });
    const lineById = new Map(lines.map((l) => [String(l.id), l]));
    const already = await returnedSoFar(lines.map((l) => l.id), transaction);

    const plans = dto.items.map(({ orderLineId, quantity }) => {
      const line = lineById.get(String(orderLineId));
      if (!line) throw ApiError.badRequest("A returned item is not on this order");
      const prior = already.get(String(line.id)) || { quantity: 0, lineTotal: 0, gstAmount: 0 };
      const remaining = line.quantity - prior.quantity;
      if (quantity > remaining) {
        throw ApiError.badRequest(
          remaining > 0 ? `Only ${remaining} unit(s) of this item can still be returned` : "This item has already been fully returned",
          { details: { [`items.${orderLineId}`]: [`At most ${remaining}`] } }
        );
      }
      return { line, quantity, ...shareOf(line, quantity, prior) };
    });

    const totals = plans.reduce(
      (acc, p) => ({
        refund: acc.refund + toPaise(p.lineTotal),
        gst: acc.gst + toPaise(p.gstAmount),
        taxable: acc.taxable + toPaise(p.taxableAmount),
      }),
      { refund: 0, gst: 0, taxable: 0 }
    );

    const record = await MedicineReturn.create(
      {
        orderGroupId: group.id,
        providerId,
        patientId: group.patientId,
        reason: dto.reason || null,
        restocked: dto.restock !== false,
        itemCount: plans.reduce((n, p) => n + p.quantity, 0),
        taxableTotal: fromPaise(totals.taxable),
        gstTotal: fromPaise(totals.gst),
        refundAmount: fromPaise(totals.refund),
        createdBy: userId,
      },
      { transaction }
    );
    await record.update({ creditNoteNumber: documentNumber(DOCUMENT_PREFIX.CREDIT_NOTE, record.id) }, { transaction });

    const medicines = await stockService.lockInventories(plans.map((p) => p.line.medicineId), transaction);
    await MedicineReturnItem.bulkCreate(
      plans.map((p) => {
        const med = medicines.get(String(p.line.medicineId));
        return {
          returnId: record.id,
          orderLineId: p.line.id,
          medicineId: med ? med.id : null,
          medicineName: med ? [med.medicineName, med.strength].filter(Boolean).join(" ") : "Medicine",
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          gstRate: p.line.gstRate,
          taxableAmount: p.taxableAmount,
          gstAmount: p.gstAmount,
          lineTotal: p.lineTotal,
        };
      }),
      { transaction }
    );

    // Back on the shelf — on the very batches the units were sold from.
    if (dto.restock !== false) {
      await stockService.restoreLines(
        plans.map((p) => p.line),
        { transaction, type: STOCK_MOVEMENT_TYPE.RETURN, note: `Return ${record.creditNoteNumber}`, userId },
        new Map(plans.map((p) => [String(p.line.id), p.quantity]))
      );
    }

    // Fully returned + paid → the bill is refunded (existing payment status).
    const returnedAll = lines.every((l) => {
      const before = already.get(String(l.id))?.quantity || 0;
      const now = plans.find((p) => String(p.line.id) === String(l.id))?.quantity || 0;
      return before + now >= l.quantity;
    });
    if (returnedAll && group.paymentStatus === MEDICINE_ORDER_PAYMENT_STATUS.PAID) {
      await group.update({ paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.REFUNDED }, { transaction });
      await MedicineOrder.update(
        { paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.REFUNDED },
        { where: { orderGroupId: group.id }, transaction }
      );
    }

    await MedicineNotification.create(
      {
        userId: group.patientId,
        title: "Return recorded",
        message: `Credit note ${record.creditNoteNumber} for order ${group.orderNumber}: ₹${fromPaise(totals.refund).toFixed(2)}.`,
        type: "order_returned",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
    return record.id;
  });

  return exports.get(providerId, returnId);
};

/** One credit note — readable by its pharmacy or its patient. */
exports.get = async (userId, id) => {
  const row = await MedicineReturn.findByPk(id, { include: RETURN_INCLUDE });
  if (!row || (!sameId(row.providerId, userId) && !sameId(row.patientId, userId))) {
    throw ApiError.notFound("Return not found");
  }
  const data = serialize(row);
  return {
    ...data,
    gstSummary: gstBreakup(data.items),
    store: await settingsService.getStore(row.providerId),
  };
};

/** The pharmacy's credit notes, newest first; search = credit-note / order number. */
exports.list = async (providerId, { search, from, to, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (from || to) {
    const bounds = istDateRangeBounds(from || "2000-01-01", to || "2999-12-31");
    where.createdAt = { [Op.gte]: bounds.from, [Op.lt]: bounds.to };
  }
  if (search) {
    const groups = await MedicineOrderGroup.findAll({
      where: { providerId, orderNumber: { [Op.like]: `%${search}%` } },
      attributes: ["id"],
      limit: 500,
    });
    where[Op.or] = [
      { creditNoteNumber: { [Op.like]: `%${search}%` } },
      ...(groups.length ? [{ orderGroupId: { [Op.in]: groups.map((g) => g.id) } }] : []),
    ];
  }
  const { rows, count } = await MedicineReturn.findAndCountAll({
    where,
    include: RETURN_INCLUDE,
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { returns: rows.map(serialize), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};
