/**
 * Checkout, billing, payment and order-group lifecycle for medicine orders.
 *
 * One checkout produces ONE group per pharmacy (`medicine_order_groups`), and
 * the group's lines are the EXISTING `medicine_orders` rows — one per medicine,
 * each keeping its own provider-specific unit price. Nothing about the
 * pharmacy's per-order management or the historical orders changed; the group
 * is a header placed above them.
 *
 * Trust rules (README §5 / the security section of this phase):
 *   - the client sends ids, quantities, a payment METHOD and a delivery
 *     location, and nothing else;
 *   - price, stock, provider, provider type, line totals and the order total
 *     are all re-read and recomputed here, under `SELECT … FOR UPDATE` on each
 *     inventory row, inside one transaction with the stock decrement;
 *   - a patient can only ever read/act on their own groups, a pharmacy only on
 *     groups addressed to it.
 *
 * Payment is SIMULATED in this phase (see medicinePayment.model): no gateway,
 * no credentials, no money. COD leaves the bill unpaid by design; "online"
 * runs through an explicit confirm step that a real gateway callback can later
 * replace without touching anything below it.
 */
const { Op, UniqueConstraintError } = require("sequelize");
const {
  sequelize,
  MedicineCartItem,
  MedicineOrderGroup,
  MedicineOrder,
  MedicinePayment,
  MedicineStoreMedicine,
  MedicineNotification,
  MedicineReturn,
  MedicineReturnItem,
  MedicineStockMovement,
  MedicineStockBatch,
  PrescriptionRequest,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");
const { sameId } = require("../utils/ids");
const { priceSaleLine, sumSaleLines, gstBreakup } = require("../utils/medicinePricing");
const { istDateRangeBounds } = require("../utils/period");
const cartService = require("./medicineCart.service");
const stockService = require("./pharmacyStock.service");
const settingsService = require("./pharmacySettings.service");
const paymentQrService = require("./paymentQr.service");
const { STOCK_MOVEMENT_TYPE, STOCK_REFERENCE } = require("../config/pharmacy");
const {
  ERROR_CODES,
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_TRANSITIONS,
  MEDICINE_ORDER_CANCELLABLE,
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_PAYMENT_METHOD,
  MEDICINE_LIVE_ON_PLACE_METHODS,
  MEDICINE_PAYMENT_GATEWAY,
  MEDICINE_PAYMENT_ATTEMPT_STATUS,
  PRESCRIPTION_REQUEST_STATUS,
} = require("../config/constants");

const LINE_MEDICINE_ATTRS = [
  "id",
  "medicineName",
  "genericName",
  "medicineType",
  "strength",
  "manufacturer",
  "imageUrl",
  "price",
  "stock",
  "packSize",
];

const GROUP_INCLUDE = [
  {
    model: MedicineOrder,
    as: "items",
    include: [
      { model: MedicineStoreMedicine, as: "medicine", attributes: LINE_MEDICINE_ATTRS },
      // Returned units per line (credit notes), so a bill shows what came back.
      { model: MedicineReturnItem, as: "returnItems", attributes: ["id", "quantity", "lineTotal"] },
    ],
  },
  { model: User, as: "provider", attributes: ["id", "name", "role", "phone", "city", "state"] },
  { model: User, as: "patient", attributes: ["id", "name", "phone", "email"] },
  { model: MedicineReturn, as: "returns", attributes: ["id", "creditNoteNumber", "refundAmount", "restocked", "createdAt"] },
  // The payment attempt(s) — what serializeGroup's `payment` block reads (the
  // patient's UPI QR report lives here, migration 044).
  {
    model: MedicinePayment,
    as: "payments",
    attributes: ["id", "method", "status", "gateway", "payerReference", "payerReportedAt", "paidAt"],
  },
];

/** Round money the same way everywhere (2dp, no float drift in the response). */
const money = (value) => Number(Number(value).toFixed(2));

/**
 * Human-facing order/bill number: MO-YYYYMMDD-000123. Derived from the group's
 * own primary key, so it is unique by construction and never needs a counter
 * table or a uniqueness retry.
 */
function orderNumberFor(groupId, date = new Date()) {
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  return `MO-${ymd}-${String(groupId).padStart(6, "0")}`;
}

/**
 * Validate one requested line against the provider's LIVE inventory row, held
 * under a row lock for the rest of the transaction. This is the only place a
 * price is decided and the only place stock is judged.
 */
async function lockAndValidate({ medicineId, quantity }, transaction) {
  const medicine = await MedicineStoreMedicine.findByPk(medicineId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!medicine || !medicine.isActive) throw ApiError.badRequest("A selected medicine is no longer available");

  const provider = await User.findOne({
    where: { id: medicine.providerId, isActive: true },
    attributes: ["id", "role"],
    transaction,
  });
  if (!provider) throw ApiError.badRequest("This pharmacy is not accepting orders");
  if (!ACTIVE_MEDICINE_PROVIDER_ROLES.includes(provider.role)) {
    throw ApiError.badRequest("This provider is no longer accepting new orders");
  }
  if (medicine.stock < quantity) {
    throw ApiError.badRequest(
      `Only ${medicine.stock} of ${medicine.medicineName} are in stock`,
      { code: ERROR_CODES.STOCK_UNAVAILABLE }
    );
  }
  return { medicine, provider };
}

/**
 * The shared core of every new medicine order: validate the requested lines,
 * split them per pharmacy, create one group + its order lines per pharmacy,
 * decrement stock, and open a payment row.
 *
 * COD is final immediately (the pharmacy is told at once, payment stays
 * `pending` until the rider collects). An online order is created but NOT
 * announced to the pharmacy until the simulated payment succeeds — so a
 * pharmacy is never asked to prepare an order that was never paid for.
 *
 * @param {number} patientId
 * @param {Array<{medicineId, quantity, prescriptionRequestId?}>} requestedLines
 * @param {object} dto  paymentMethod + delivery location + notes
 * @param {object} [options]
 * @param {number[]} [options.clearCartItemIds] cart lines to consume on success
 */
/**
 * The "online" method is a SIMULATION (gateway 'simulated', the client picks
 * the outcome) — there is no payment gateway for medicine orders yet. It must
 * never mark a real order paid, so production refuses it outright.
 */
function assertOnlineAvailable(method) {
  if (method === MEDICINE_PAYMENT_METHOD.ONLINE && env.NODE_ENV === "production") {
    throw ApiError.badRequest(
      "Online payment isn't available for medicine orders yet. Please choose Cash on Delivery or the pharmacy's UPI QR.",
      { code: ERROR_CODES.ORDER_NOT_PAYABLE }
    );
  }
}

async function createOrder(patientId, requestedLines, dto, { clearCartItemIds } = {}) {
  assertOnlineAvailable(dto.paymentMethod);
  if (!requestedLines.length) {
    throw ApiError.badRequest("Select at least one medicine to order", { code: ERROR_CODES.CART_EMPTY });
  }

  // COD and the pharmacy's own UPI QR are LIVE at checkout (the pharmacy sees
  // and prepares the order; the money is collected / confirmed outside the
  // platform). Only the simulated online method waits for its payment.
  const liveOnPlace = MEDICINE_LIVE_ON_PLACE_METHODS.includes(dto.paymentMethod);
  const isUpiQr = dto.paymentMethod === MEDICINE_PAYMENT_METHOD.UPI_QR;

  // One line per inventory row: the stock allocation below works on one locked
  // row instance per line, so the same medicine twice would be judged against a
  // stale stock count. Quantities of a repeated medicine are merged instead.
  const merged = new Map();
  for (const line of requestedLines) {
    const key = String(line.medicineId);
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, quantity: Number(prev.quantity) + Number(line.quantity) } : { ...line });
  }

  const groupIds = await sequelize.transaction(async (transaction) => {
    // 0. A cart checkout claims its cart lines FIRST, under a row lock. Two
    //    submits of the same cart (double click, a retried request, two tabs)
    //    serialize here: the second waits, then finds the lines already
    //    consumed and stops — instead of placing the same order twice.
    if (clearCartItemIds?.length) {
      const claimed = await MedicineCartItem.findAll({
        where: { id: { [Op.in]: clearCartItemIds }, patientId },
        attributes: ["id"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (claimed.length !== new Set(clearCartItemIds.map(String)).size) {
        throw ApiError.conflict("Your cart changed while placing this order — it may already have been placed. Check My Orders.", {
          code: ERROR_CODES.CART_EMPTY,
        });
      }
    }

    // 1. Lock + validate every line first; one bad line aborts the whole order.
    //    Lines are locked in a stable id order so two concurrent checkouts over
    //    the same medicines can never deadlock each other.
    const ordered = [...merged.values()].sort((a, b) => Number(a.medicineId) - Number(b.medicineId));
    const validated = [];
    for (const line of ordered) {
      const { medicine } = await lockAndValidate(line, transaction);
      // THE price: the provider's live selling price, item discount and GST
      // rate, priced by the one shared function the cart also shows.
      validated.push({ ...line, medicine, priced: priceSaleLine(medicine, line.quantity) });
    }

    // 2. One group per pharmacy — a group is always one patient, one provider.
    const byProvider = new Map();
    for (const line of validated) {
      const key = String(line.medicine.providerId);
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key).push(line);
    }

    // 2b. UPI QR: every pharmacy in this checkout must have its own QR set up,
    //     or nothing is created (one query for all of them; the transaction
    //     rolls back the cart claim + row locks taken above).
    if (isUpiQr) {
      const configured = await paymentQrService.configuredIds([...byProvider.keys()]);
      if ([...byProvider.keys()].some((id) => !configured.has(id))) {
        throw ApiError.conflict(
          "A pharmacy in this order doesn't accept UPI QR payments — choose Cash on Delivery",
          { code: ERROR_CODES.PAYMENT_QR_UNAVAILABLE }
        );
      }
    }

    const created = [];
    const stockChanges = [];
    for (const lines of byProvider.values()) {
      const first = lines[0].medicine;
      // THE order totals: the backend's own sum of its priced lines. GST is
      // INSIDE the selling price, so it is a breakdown, never an extra charge.
      const totals = sumSaleLines(lines.map((l) => l.priced));
      const prescriptionRequestId = lines.find((l) => l.prescriptionRequestId)?.prescriptionRequestId || null;

      // Take the units off the shelf FIRST (untracked, then batches
      // first-expiry-first-out, never an expired batch). Any line that can't
      // be covered by in-date stock aborts the whole order.
      for (const l of lines) {
        const { allocations, movements, stockBefore } = await stockService.allocateSale(l.medicine, l.quantity, {
          transaction,
          type: STOCK_MOVEMENT_TYPE.SALE,
          userId: patientId,
        });
        l.allocations = allocations;
        l.movements = movements;
        stockChanges.push({ inventory: l.medicine, before: stockBefore });
      }

      const group = await MedicineOrderGroup.create(
        {
          patientId,
          providerId: first.providerId,
          providerType: first.providerType,
          itemCount: lines.reduce((n, l) => n + l.quantity, 0),
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          taxableTotal: totals.taxableTotal,
          gstTotal: totals.gstTotal,
          // No delivery fee exists on this platform, so none is added.
          totalAmount: totals.total,
          paymentMethod: dto.paymentMethod,
          paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PENDING,
          status: MEDICINE_ORDER_STATUS.PENDING,
          deliveryAddress: dto.deliveryAddress,
          deliveryCity: dto.deliveryCity || null,
          deliveryState: dto.deliveryState || null,
          deliveryPincode: dto.deliveryPincode || null,
          deliveryLat: dto.deliveryLat ?? null,
          deliveryLng: dto.deliveryLng ?? null,
          notes: dto.notes || null,
          prescriptionRequestId,
          placedAt: liveOnPlace ? new Date() : null,
        },
        { transaction }
      );
      await group.update({ orderNumber: orderNumberFor(group.id) }, { transaction });

      // 3. The lines: the EXISTING medicine_orders rows, now carrying a group
      //    and a frozen snapshot of price, discount, GST, cost and batch.
      const lineRows = await MedicineOrder.bulkCreate(
        lines.map((l) => {
          const firstBatch = l.allocations.find((a) => a.batchId);
          return {
            patientId,
            orderGroupId: group.id,
            providerId: l.medicine.providerId,
            providerType: l.medicine.providerType,
            medicineId: l.medicine.id,
            quantity: l.quantity,
            unitPrice: l.priced.unitPrice,
            mrp: l.medicine.mrp,
            discountPercent: l.priced.discountPercent,
            discountAmount: l.priced.discountAmount,
            gstRate: l.priced.gstRate,
            taxableAmount: l.priced.taxableAmount,
            gstAmount: l.priced.gstAmount,
            unitCost: l.medicine.buyingPrice,
            hsnCode: l.medicine.hsnCode,
            batchNumber: firstBatch?.batchNumber ?? null,
            expiryDate: firstBatch?.expiryDate ?? null,
            totalPrice: l.priced.lineTotal,
            status: MEDICINE_ORDER_STATUS.PENDING,
            paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PENDING,
            deliveryAddress: dto.deliveryAddress,
            notes: dto.notes || null,
            prescriptionRequestId: l.prescriptionRequestId || null,
          };
        }),
        { transaction }
      );

      // 4. Ledger the stock that left (allocated above) against each line, so
      //    a cancel / rejection / failed payment / return puts exactly those
      //    units back on exactly those batches. Same rule as before: stock
      //    leaves the shelf when the order is created.
      await stockService.recordMovements(
        lines.flatMap((l, i) =>
          l.movements.map((m) => ({ ...m, referenceType: STOCK_REFERENCE.ORDER_LINE, referenceId: lineRows[i].id }))
        ),
        transaction
      );

      // 5. Open the payment. COD is recorded as an expected cash collection,
      //    a UPI QR order as an expected transfer to the pharmacy's own UPI
      //    (`manual_upi`) — neither as a successful payment.
      await MedicinePayment.create(
        {
          orderGroupId: group.id,
          amount: totals.total,
          method: dto.paymentMethod,
          status: MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING,
          gateway: isUpiQr ? MEDICINE_PAYMENT_GATEWAY.MANUAL_UPI : MEDICINE_PAYMENT_GATEWAY.SIMULATED,
        },
        { transaction }
      );

      // 6. A COD / UPI QR order is live the moment it is placed, so tell the
      //    pharmacy now. An online order waits for the payment result (§24).
      if (liveOnPlace) {
        await notifyOrderPlaced(group, transaction);
      }

      created.push(group.id);
    }

    // Tell the pharmacy when this order pushed an item to/below its reorder level.
    await stockService.notifyLowStock(stockChanges, transaction);

    // 7. Consume the cart lines this checkout used (and only those).
    if (clearCartItemIds?.length) {
      await MedicineCartItem.destroy({
        where: { id: { [Op.in]: clearCartItemIds }, patientId },
        transaction,
      });
    }

    return created;
  });

  const groups = await MedicineOrderGroup.findAll({ where: { id: { [Op.in]: groupIds } }, include: GROUP_INCLUDE });
  return {
    groups: groups.map((g) => serializeGroup(g)),
    // TRUE only for the simulated online flow, exactly as before — a UPI QR
    // order is already placed, so older clients must not open the pay screen.
    requiresPayment: dto.paymentMethod === MEDICINE_PAYMENT_METHOD.ONLINE,
    /** 'upi_qr' → show the pharmacy's QR (GET /groups/:id/payment-qr) for each group. */
    paymentInstructions: isUpiQr ? MEDICINE_PAYMENT_METHOD.UPI_QR : null,
  };
}

/** How the pharmacy's "new order" notification names the payment. */
const PAYMENT_METHOD_NOTE = {
  [MEDICINE_PAYMENT_METHOD.COD]: "Cash on Delivery",
  [MEDICINE_PAYMENT_METHOD.ONLINE]: "paid online",
  [MEDICINE_PAYMENT_METHOD.UPI_QR]: "UPI payment to your QR — verify receipt in your UPI app",
};

/** Tell the pharmacy (and confirm to the patient) that an order is live. */
async function notifyOrderPlaced(group, transaction) {
  await MedicineNotification.bulkCreate(
    [
      {
        userId: group.providerId,
        title: "New medicine order received",
        message: `Order ${group.orderNumber} — ${group.itemCount} item(s), ₹${money(group.totalAmount).toFixed(2)}, ${
          PAYMENT_METHOD_NOTE[group.paymentMethod] || "paid online"
        }.`,
        type: "order_placed",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      {
        userId: group.patientId,
        title: "Order confirmed",
        message: `Your order ${group.orderNumber} has been placed. Total ₹${money(group.totalAmount).toFixed(2)}.${
          group.paymentMethod === MEDICINE_PAYMENT_METHOD.UPI_QR
            ? " Pay the pharmacy's UPI QR from your order — the pharmacy confirms once it receives the money."
            : ""
        }`,
        type: "order_placed",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
    ],
    { transaction }
  );
}

/**
 * Checkout the patient's cart (or the selected lines of it).
 *
 * The cart is only the SOURCE of ids and quantities: every line is re-priced
 * and re-stock-checked in createOrder, so a stale cart can never place a
 * cheaper order than the pharmacy is currently offering.
 */
exports.checkout = async (patientId, dto) => {
  const lines = await cartService.findLines(patientId);
  const selected = dto.itemIds?.length
    ? lines.filter((l) => dto.itemIds.map(String).includes(String(l.id)))
    : lines;

  if (!selected.length) {
    throw ApiError.badRequest("Your cart is empty", { code: ERROR_CODES.CART_EMPTY });
  }
  const blocked = selected.find((line) => cartService.lineBlocker(line));
  if (blocked) {
    throw ApiError.badRequest(
      `${blocked.medicine?.medicineName || "An item"} cannot be ordered: ${cartService.lineBlocker(blocked)}`,
      { code: ERROR_CODES.STOCK_UNAVAILABLE }
    );
  }

  const result = await createOrder(
    patientId,
    selected.map((l) => ({
      medicineId: l.medicineId,
      quantity: l.quantity,
      prescriptionRequestId: l.prescriptionRequestId,
    })),
    dto,
    { clearCartItemIds: selected.map((l) => l.id) }
  );

  // An online order is not final until its payment succeeds, so its
  // prescription stays open until then (payGroup closes it). COD / UPI QR
  // orders are final at checkout.
  if (MEDICINE_LIVE_ON_PLACE_METHODS.includes(dto.paymentMethod)) await closePrescriptionRequests(result.groups);
  return result;
};

/**
 * Order one medicine directly, without going through the cart (the pre-036
 * "Place Order" button). Same validation, same group, same bill — a direct
 * order is simply a checkout of a single line.
 */
exports.orderDirect = async (patientId, dto) => {
  const result = await createOrder(
    patientId,
    [{ medicineId: dto.medicineId, quantity: dto.quantity }],
    dto
  );
  return result;
};

/**
 * Order the medicines a pharmacy marked available on a shared prescription,
 * without a cart round-trip (the "Order these now" button on the prescription
 * response). Same validation, same group, same bill, same payment — the only
 * difference from a cart checkout is where the lines came from.
 */
exports.orderFromPrescription = async (patientId, requestId, selections, dto) => {
  const { request, plans } = await cartService.resolvePrescriptionSelections(patientId, requestId, selections);

  const result = await createOrder(
    patientId,
    plans.map((plan) => ({ ...plan, prescriptionRequestId: request.id })),
    dto
  );

  // A COD / UPI QR order is final at checkout, so the prescription is done. An
  // online order closes the request only once its payment succeeds.
  if (MEDICINE_LIVE_ON_PLACE_METHODS.includes(dto.paymentMethod)) await closePrescriptionRequests(result.groups);
  return result;
};

/**
 * A shared prescription is finished once its medicines have been ordered.
 * Uses the EXISTING prescription_requests status, not a parallel flag.
 */
async function closePrescriptionRequests(groups) {
  const ids = [...new Set(groups.map((g) => g.prescriptionRequestId).filter(Boolean))];
  if (!ids.length) return;
  // Scoped to the ordering patient: only their own shared prescriptions close.
  const patientIds = [...new Set(groups.map((g) => g.patientId).filter(Boolean))];
  await PrescriptionRequest.update(
    { status: PRESCRIPTION_REQUEST_STATUS.COMPLETED },
    {
      where: {
        id: { [Op.in]: ids },
        patientId: { [Op.in]: patientIds },
        status: { [Op.notIn]: [PRESCRIPTION_REQUEST_STATUS.REJECTED] },
      },
    }
  );
}

/**
 * Settle an online order's SIMULATED payment.
 *
 * This is the seam a real gateway callback will replace: it takes an outcome
 * and an idempotency key and does exactly what a verified webhook would —
 * flip the bill, release or reverse the stock, and notify. No gateway is
 * contacted, no money moves, and the stored reference is an obviously
 * synthetic "SIM-…" string so it can never be mistaken for a bank transaction.
 *
 * Idempotent: the unique `idempotency_key`, plus the already-settled early
 * return, mean a retried or double-clicked payment can never create a second
 * charge or a second order.
 *
 * @param {number} patientId
 * @param {number|string} groupId
 * @param {{outcome?: "success"|"failure", idempotencyKey?: string}} dto
 */
exports.payGroup = async (patientId, groupId, { outcome = "success", idempotencyKey } = {}) => {
  const group = await MedicineOrderGroup.findByPk(groupId);
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.patientId, patientId)) throw ApiError.forbidden("Not authorized");

  if (group.paymentMethod !== MEDICINE_PAYMENT_METHOD.ONLINE) {
    throw ApiError.badRequest(
      group.paymentMethod === MEDICINE_PAYMENT_METHOD.UPI_QR
        ? "This order is paid to the pharmacy's UPI QR — there is nothing to pay online"
        : "This order is Cash on Delivery — there is nothing to pay online",
      { code: ERROR_CODES.ORDER_NOT_PAYABLE }
    );
  }
  // Replaying a settled payment returns the settled order instead of charging
  // again or erroring — that is what makes a retried callback safe.
  if (group.paymentStatus === MEDICINE_ORDER_PAYMENT_STATUS.PAID) {
    return { group: await exports.getGroupById(patientId, group.id), alreadySettled: true };
  }
  if (group.status === MEDICINE_ORDER_STATUS.CANCELLED) {
    throw ApiError.badRequest("This order was cancelled", { code: ERROR_CODES.ORDER_NOT_PAYABLE });
  }
  // The client-chosen outcome is only acceptable while it is a simulation.
  assertOnlineAvailable(group.paymentMethod);

  const succeeded = outcome === "success";

  await sequelize.transaction(async (transaction) => {
    const attempt = {
      orderGroupId: group.id,
      amount: group.totalAmount,
      method: MEDICINE_PAYMENT_METHOD.ONLINE,
      gateway: MEDICINE_PAYMENT_GATEWAY.SIMULATED,
      idempotencyKey: idempotencyKey || null,
      status: succeeded ? MEDICINE_PAYMENT_ATTEMPT_STATUS.SUCCESS : MEDICINE_PAYMENT_ATTEMPT_STATUS.FAILED,
      // Deliberately self-describing: SIM- marks it as simulated, so no reader
      // can mistake it for a real payment reference.
      reference: succeeded ? `SIM-${group.orderNumber}-${Date.now()}` : null,
      failureReason: succeeded ? null : "Simulated payment declined",
      paidAt: succeeded ? new Date() : null,
    };

    try {
      // Reuse the row opened at checkout when it is still pending, so a group
      // does not accumulate an orphan attempt.
      const pending = await MedicinePayment.findOne({
        where: { orderGroupId: group.id, status: MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (pending) await pending.update(attempt, { transaction });
      else await MedicinePayment.create(attempt, { transaction });
    } catch (err) {
      // Another request already settled this exact key — treat it as settled.
      if (!(err instanceof UniqueConstraintError)) throw err;
      return;
    }

    if (succeeded) {
      await group.update(
        { paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID, placedAt: group.placedAt || new Date() },
        { transaction }
      );
      await MedicineOrder.update(
        { paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID },
        { where: { orderGroupId: group.id }, transaction }
      );
      await notifyOrderPlaced(group, transaction);
      if (group.prescriptionRequestId) {
        await PrescriptionRequest.update(
          { status: PRESCRIPTION_REQUEST_STATUS.COMPLETED },
          { where: { id: group.prescriptionRequestId, patientId: group.patientId }, transaction }
        );
      }
      return;
    }

    // Failed payment: the order never becomes real, so the reserved stock goes
    // straight back on the shelf and the pharmacy is never told about it.
    await group.update(
      {
        paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.FAILED,
        status: MEDICINE_ORDER_STATUS.CANCELLED,
      },
      { transaction }
    );
    await restoreStockFor(group.id, transaction, `Payment failed — ${group.orderNumber}`);
    await MedicineOrder.update(
      { status: MEDICINE_ORDER_STATUS.CANCELLED, paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.FAILED },
      { where: { orderGroupId: group.id }, transaction }
    );
    await MedicineNotification.create(
      {
        userId: group.patientId,
        title: "Payment failed",
        message: `Payment for order ${group.orderNumber} did not go through. The order was not placed.`,
        type: "order_payment_failed",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
  });

  if (!succeeded) {
    throw ApiError.badRequest("Payment failed — the order was not placed", {
      code: ERROR_CODES.PAYMENT_FAILED,
      details: { orderGroupId: Number(group.id) },
    });
  }

  return { group: await exports.getGroupById(patientId, group.id), alreadySettled: false };
};

/**
 * Put every line's outstanding units back on its provider's shelf — on the
 * exact batches they were sold from (read from the stock ledger), under row
 * locks. Units already returned are not put back twice.
 */
async function restoreStockFor(groupId, transaction, note) {
  const lines = await MedicineOrder.findAll({
    where: { orderGroupId: groupId },
    attributes: ["id", "medicineId", "quantity"],
    transaction,
  });
  await stockService.restoreLines(lines, { transaction, type: STOCK_MOVEMENT_TYPE.SALE_REVERSAL, note });
}

const optionalMoney = (value) => (value === null || value === undefined ? null : money(value));

/**
 * Every field a client needs, with money as numbers and ids as numbers.
 *
 * `viewer: "provider"` adds the pharmacy-private cost snapshot (unitCost) the
 * margin figures use; a patient's view never carries it.
 */
function serializeGroup(group, { viewer = "patient" } = {}) {
  const plain = group.toJSON ? group.toJSON() : group;
  const isProvider = viewer === "provider";
  const returns = (plain.returns || []).map((r) => ({
    id: Number(r.id),
    creditNoteNumber: r.creditNoteNumber,
    refundAmount: money(r.refundAmount),
    restocked: !!r.restocked,
    createdAt: r.createdAt,
  }));
  const refundedTotal = money(returns.reduce((sum, r) => sum + r.refundAmount, 0));
  // The latest payment attempt (a COD / UPI QR order has exactly one).
  const attempt = (plain.payments || []).reduce((last, p) => (!last || Number(p.id) > Number(last.id) ? p : last), null);
  return {
    id: Number(plain.id),
    orderNumber: plain.orderNumber,
    patientId: Number(plain.patientId),
    providerId: Number(plain.providerId),
    providerType: plain.providerType,
    itemCount: plain.itemCount,
    subtotal: money(plain.subtotal),
    discountTotal: money(plain.discountTotal || 0),
    /** NULL on orders placed before GST data was recorded. */
    taxableTotal: optionalMoney(plain.taxableTotal),
    gstTotal: money(plain.gstTotal || 0),
    totalAmount: money(plain.totalAmount),
    refundedTotal,
    returns,
    paymentMethod: plain.paymentMethod,
    paymentStatus: plain.paymentStatus,
    /**
     * The same payment, plus what the patient REPORTED paying to a UPI QR
     * (migration 044) — unverified until the pharmacy confirms receipt.
     */
    payment: {
      method: plain.paymentMethod,
      status: plain.paymentStatus,
      payerReference: attempt?.payerReference ?? null,
      reportedAt: attempt?.payerReportedAt ?? null,
    },
    status: plain.status,
    deliveryAddress: plain.deliveryAddress,
    deliveryCity: plain.deliveryCity,
    deliveryState: plain.deliveryState,
    deliveryPincode: plain.deliveryPincode,
    notes: plain.notes,
    prescriptionRequestId: plain.prescriptionRequestId ? Number(plain.prescriptionRequestId) : null,
    placedAt: plain.placedAt,
    createdAt: plain.createdAt,
    provider: plain.provider
      ? { id: Number(plain.provider.id), name: plain.provider.name, role: plain.provider.role, phone: plain.provider.phone, city: plain.provider.city, state: plain.provider.state }
      : null,
    patient: plain.patient
      ? { id: Number(plain.patient.id), name: plain.patient.name, phone: plain.patient.phone }
      : null,
    items: (plain.items || []).map((item) => ({
      id: Number(item.id),
      medicineId: Number(item.medicineId),
      medicineName: item.medicine?.medicineName ?? null,
      strength: item.medicine?.strength ?? null,
      medicineType: item.medicine?.medicineType ?? null,
      packSize: item.medicine?.packSize ?? null,
      imageUrl: item.medicine?.imageUrl ?? null,
      quantity: item.quantity,
      returnedQuantity: (item.returnItems || []).reduce((n, r) => n + Number(r.quantity), 0),
      unitPrice: money(item.unitPrice),
      mrp: optionalMoney(item.mrp),
      discountPercent: Number(item.discountPercent || 0),
      discountAmount: money(item.discountAmount || 0),
      gstRate: Number(item.gstRate || 0),
      taxableAmount: optionalMoney(item.taxableAmount),
      gstAmount: money(item.gstAmount || 0),
      hsnCode: item.hsnCode ?? null,
      batchNumber: item.batchNumber ?? null,
      expiryDate: item.expiryDate ?? null,
      lineTotal: money(item.totalPrice),
      ...(isProvider ? { unitCost: optionalMoney(item.unitCost) } : {}),
      status: item.status,
    })),
  };
}
exports.serializeGroup = serializeGroup;

/** The patient's own orders, newest first. */
exports.getMyGroups = async (patientId, { status, page = 1, limit = 20 } = {}) => {
  const where = { patientId };
  if (status) where.status = status;

  const { rows, count } = await MedicineOrderGroup.findAndCountAll({
    where,
    include: GROUP_INCLUDE,
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { orders: rows.map((g) => serializeGroup(g)), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/**
 * The orders a pharmacy may see: its own, and only once they are real — an
 * online order that has not been paid for is withheld (the pharmacy is told
 * about an order when it becomes real, not while a payment is outstanding).
 * Shared by the order list, the invoice list and the reports.
 */
function visibleToProviderWhere(providerId) {
  return {
    providerId,
    [Op.or]: [
      // COD and UPI QR orders are live from checkout.
      { paymentMethod: { [Op.in]: [...MEDICINE_LIVE_ON_PLACE_METHODS] } },
      // A paid order stays visible after it is refunded (a full return).
      { paymentStatus: { [Op.in]: [MEDICINE_ORDER_PAYMENT_STATUS.PAID, MEDICINE_ORDER_PAYMENT_STATUS.REFUNDED] } },
    ],
  };
}
exports.visibleToProviderWhere = visibleToProviderWhere;

/**
 * A pharmacy's incoming orders, filtered in the database. `providerId` is the
 * signed-in provider, so a pharmacy can never see another pharmacy's orders.
 *
 * `search` matches the order number or the patient's name; `from`/`to` are
 * IST days on the order date; `medicineId` keeps orders containing that
 * inventory row.
 */
exports.getProviderGroups = async (
  providerId,
  { status, paymentStatus, paymentMethod, search, from, to, medicineId, page = 1, limit = 20 } = {}
) => {
  const and = [visibleToProviderWhere(providerId)];
  if (status) and.push({ status });
  if (paymentStatus) and.push({ paymentStatus });
  if (paymentMethod) and.push({ paymentMethod });
  if (from || to) {
    const bounds = istDateRangeBounds(from || "2000-01-01", to || "2999-12-31");
    and.push({ createdAt: { [Op.gte]: bounds.from, [Op.lt]: bounds.to } });
  }
  if (search) {
    // Patients are resolved first (one query) so pagination stays a simple
    // query on the order table instead of a join the LIMIT would cut through.
    const patients = await User.findAll({
      where: { name: { [Op.like]: `%${search}%` } },
      attributes: ["id"],
      limit: 500,
    });
    and.push({
      [Op.or]: [
        { orderNumber: { [Op.like]: `%${search}%` } },
        ...(patients.length ? [{ patientId: { [Op.in]: patients.map((u) => u.id) } }] : []),
      ],
    });
  }
  if (medicineId) {
    const lines = await MedicineOrder.findAll({
      where: { providerId, medicineId, orderGroupId: { [Op.ne]: null } },
      attributes: ["orderGroupId"],
      group: ["orderGroupId"],
      raw: true,
    });
    and.push({ id: { [Op.in]: lines.map((l) => l.orderGroupId) } });
  }

  const safeLimit = Math.min(limit, 100);
  const { rows, count } = await MedicineOrderGroup.findAndCountAll({
    where: { [Op.and]: and },
    include: GROUP_INCLUDE,
    order: [["createdAt", "DESC"]],
    limit: safeLimit,
    offset: (page - 1) * safeLimit,
    distinct: true,
  });
  return {
    orders: rows.map((g) => serializeGroup(g, { viewer: "provider" })),
    total: count,
    page,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit),
  };
};

/** One order, readable ONLY by its patient or its pharmacy. */
exports.getGroupById = async (userId, groupId) => {
  const group = await MedicineOrderGroup.findByPk(groupId, { include: GROUP_INCLUDE });
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.patientId, userId) && !sameId(group.providerId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  return serializeGroup(group, { viewer: sameId(group.providerId, userId) ? "provider" : "patient" });
};

/**
 * The pharmacy moves the order along its lifecycle. The allowed next steps
 * come from the ONE transition table in config/constants, so an arbitrary or
 * backwards jump ("delivered" straight from "pending") is rejected, and the
 * group and its lines always agree.
 */
exports.updateGroupStatus = async (providerId, groupId, newStatus) => {
  const group = await MedicineOrderGroup.findByPk(groupId);
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.providerId, providerId)) throw ApiError.forbidden("Not authorized");

  const allowed = MEDICINE_ORDER_TRANSITIONS[group.status] || [];
  if (!allowed.includes(newStatus)) {
    throw ApiError.badRequest(`Cannot move an order from '${group.status}' to '${newStatus}'`, {
      code: ERROR_CODES.INVALID_STATUS_TRANSITION,
      details: { from: group.status, allowed },
    });
  }
  if (
    newStatus === MEDICINE_ORDER_STATUS.CONFIRMED &&
    group.paymentMethod === MEDICINE_PAYMENT_METHOD.ONLINE &&
    group.paymentStatus !== MEDICINE_ORDER_PAYMENT_STATUS.PAID
  ) {
    throw ApiError.badRequest("This order has not been paid for yet", { code: ERROR_CODES.ORDER_NOT_PAYABLE });
  }

  await sequelize.transaction(async (transaction) => {
    await group.update({ status: newStatus }, { transaction });
    await MedicineOrder.update({ status: newStatus }, { where: { orderGroupId: group.id }, transaction });

    // A rejected order was never fulfilled — the stock goes back.
    if (newStatus === MEDICINE_ORDER_STATUS.REJECTED) {
      await restoreStockFor(group.id, transaction, `Order ${group.orderNumber} rejected`);
    }
    // Cash is collected on delivery, so that is when a COD bill is settled.
    if (
      newStatus === MEDICINE_ORDER_STATUS.DELIVERED &&
      group.paymentMethod === MEDICINE_PAYMENT_METHOD.COD
    ) {
      await group.update({ paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID }, { transaction });
      await MedicineOrder.update(
        { paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID },
        { where: { orderGroupId: group.id }, transaction }
      );
      await MedicinePayment.update(
        { status: MEDICINE_PAYMENT_ATTEMPT_STATUS.SUCCESS, paidAt: new Date(), reference: `COD-${group.orderNumber}` },
        { where: { orderGroupId: group.id, status: MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING }, transaction }
      );
    }

    await MedicineNotification.create(
      {
        userId: group.patientId,
        title: STATUS_TITLES[newStatus] || "Order updated",
        message: `${STATUS_MESSAGES[newStatus] || `Order status updated to ${newStatus}.`} (${group.orderNumber})`,
        type: `order_${newStatus}`,
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
  });

  return exports.getGroupById(providerId, group.id);
};

/** Patient-facing wording for each lifecycle step — one place, no drift. */
const STATUS_TITLES = {
  [MEDICINE_ORDER_STATUS.CONFIRMED]: "Order confirmed",
  [MEDICINE_ORDER_STATUS.PROCESSING]: "Order being prepared",
  [MEDICINE_ORDER_STATUS.SHIPPED]: "Out for delivery",
  [MEDICINE_ORDER_STATUS.ON_THE_WAY]: "On the way",
  [MEDICINE_ORDER_STATUS.DELIVERED]: "Order delivered",
  [MEDICINE_ORDER_STATUS.REJECTED]: "Order rejected",
  [MEDICINE_ORDER_STATUS.CANCELLED]: "Order cancelled",
};
const STATUS_MESSAGES = {
  [MEDICINE_ORDER_STATUS.CONFIRMED]: "The pharmacy confirmed your order.",
  [MEDICINE_ORDER_STATUS.PROCESSING]: "The pharmacy is preparing your medicines.",
  [MEDICINE_ORDER_STATUS.SHIPPED]: "Your order has left the pharmacy.",
  [MEDICINE_ORDER_STATUS.ON_THE_WAY]: "Your order is on the way.",
  [MEDICINE_ORDER_STATUS.DELIVERED]: "Your order has been delivered.",
  [MEDICINE_ORDER_STATUS.REJECTED]: "The pharmacy could not fulfil your order.",
};

/** The patient calls off an order that has not been prepared yet. */
exports.cancelGroup = async (patientId, groupId) => {
  const group = await MedicineOrderGroup.findByPk(groupId);
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.patientId, patientId)) throw ApiError.forbidden("Not authorized");
  if (!MEDICINE_ORDER_CANCELLABLE.includes(group.status)) {
    throw ApiError.badRequest("This order can no longer be cancelled", {
      code: ERROR_CODES.INVALID_STATUS_TRANSITION,
    });
  }

  await sequelize.transaction(async (transaction) => {
    await group.update({ status: MEDICINE_ORDER_STATUS.CANCELLED }, { transaction });
    await MedicineOrder.update(
      { status: MEDICINE_ORDER_STATUS.CANCELLED },
      { where: { orderGroupId: group.id }, transaction }
    );
    await restoreStockFor(group.id, transaction, `Order ${group.orderNumber} cancelled by patient`);
    await MedicineNotification.create(
      {
        userId: group.providerId,
        title: "Order cancelled",
        message: `The patient cancelled order ${group.orderNumber}.`,
        type: "order_cancelled",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
  });

  return exports.getGroupById(patientId, group.id);
};

// ── UPI QR payments to the pharmacy's own QR (migration 044) ─────────────────
//
// The money goes from the patient's UPI app straight to the pharmacy. Nothing
// here can see it: the patient may REPORT paying (with the UPI reference), and
// only the PHARMACY's confirm-received marks the bill paid. Refunds of a UPI
// payment (e.g. a cancelled order that was already paid) have no gateway to go
// through, so they are settled offline by the pharmacy — nothing here
// auto-refunds or rewrites the payment status on cancel.

/** The patient's OWN upi_qr order, with its open payment row. */
async function loadUpiQrGroupForPatient(patientId, groupId) {
  const group = await MedicineOrderGroup.findByPk(groupId, {
    include: [{ model: User, as: "provider", attributes: ["id", "name"] }],
  });
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.patientId, patientId)) throw ApiError.forbidden("Not authorized");
  if (group.paymentMethod !== MEDICINE_PAYMENT_METHOD.UPI_QR) {
    throw ApiError.conflict("This order isn't paid by UPI QR", { code: ERROR_CODES.PAYMENT_QR_UNAVAILABLE });
  }
  const payment = await MedicinePayment.findOne({
    where: { orderGroupId: group.id },
    order: [["id", "DESC"]],
  });
  return { group, payment };
}

/** What the patient pays, to whom, with which reference — fed to serializeQrPaymentRequest. */
async function qrPaymentRequest(group, payment) {
  const qr = await paymentQrService.requireConfigured(
    group.providerId,
    "The pharmacy has removed its UPI QR — please pay on delivery instead"
  );
  return {
    qr,
    fallbackName: group.provider?.name ?? null,
    amount: group.totalAmount,
    reference: group.orderNumber,
    paymentStatus: group.paymentStatus,
    reportedAt: payment?.payerReportedAt ?? null,
    payerReference: payment?.payerReference ?? null,
  };
}

/** GET /medicine/orders/groups/:id/payment-qr — the pharmacy's QR + amount + reference. */
exports.getPaymentQrForPatient = async (patientId, groupId) => {
  const { group, payment } = await loadUpiQrGroupForPatient(patientId, groupId);
  return qrPaymentRequest(group, payment);
};

/**
 * POST /medicine/orders/groups/:id/payment-report — "I have paid". Records the
 * patient's UPI reference for the pharmacy to check and tells the pharmacy;
 * it NEVER changes the order or payment status.
 */
exports.reportPaymentForPatient = async (patientId, groupId, { reference } = {}) => {
  const { group, payment } = await loadUpiQrGroupForPatient(patientId, groupId);
  if (
    group.status === MEDICINE_ORDER_STATUS.CANCELLED ||
    group.paymentStatus !== MEDICINE_ORDER_PAYMENT_STATUS.PENDING ||
    !payment ||
    payment.status !== MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING
  ) {
    throw ApiError.conflict("This order isn't awaiting a payment", { code: ERROR_CODES.PAYMENT_NOT_PENDING });
  }
  const request = await qrPaymentRequest(group, payment);

  await sequelize.transaction(async (transaction) => {
    await payment.update(
      { ...(reference ? { payerReference: reference } : {}), payerReportedAt: new Date() },
      { transaction }
    );
    await MedicineNotification.create(
      {
        userId: group.providerId,
        title: "Patient reports UPI payment",
        message: `Patient reports UPI payment for ${group.orderNumber} (₹${money(group.totalAmount).toFixed(2)}${
          payment.payerReference ? `, ref ${payment.payerReference}` : ""
        }). Check your UPI app, then mark the payment received.`,
        type: "order_payment_reported",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
  });

  return { ...request, reportedAt: payment.payerReportedAt, payerReference: payment.payerReference };
};

/**
 * POST /medicine/orders/groups/:id/payment/confirm-received — the pharmacy saw
 * the money in its UPI app. The ONLY writer that marks a UPI QR order paid.
 */
exports.confirmPaymentReceived = async (providerId, groupId) => {
  const group = await MedicineOrderGroup.findByPk(groupId);
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.providerId, providerId)) throw ApiError.forbidden("Not authorized");
  if (group.paymentMethod !== MEDICINE_PAYMENT_METHOD.UPI_QR) {
    throw ApiError.conflict("Only a UPI QR order is confirmed this way", { code: ERROR_CODES.ORDER_NOT_PAYABLE });
  }
  if (group.status === MEDICINE_ORDER_STATUS.CANCELLED || group.paymentStatus !== MEDICINE_ORDER_PAYMENT_STATUS.PENDING) {
    throw ApiError.conflict("This order isn't awaiting a payment", { code: ERROR_CODES.PAYMENT_NOT_PENDING });
  }

  await sequelize.transaction(async (transaction) => {
    const payment = await MedicinePayment.findOne({
      where: { orderGroupId: group.id, status: MEDICINE_PAYMENT_ATTEMPT_STATUS.PENDING },
      order: [["id", "DESC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const settled = {
      status: MEDICINE_PAYMENT_ATTEMPT_STATUS.SUCCESS,
      paidAt: new Date(),
      // The patient's own UPI reference when they reported one; otherwise a
      // self-describing marker — never an invented bank transaction id.
      reference: payment?.payerReference || `UPI-${group.orderNumber}`,
    };
    if (payment) await payment.update(settled, { transaction });
    else {
      await MedicinePayment.create(
        {
          orderGroupId: group.id,
          amount: group.totalAmount,
          method: MEDICINE_PAYMENT_METHOD.UPI_QR,
          gateway: MEDICINE_PAYMENT_GATEWAY.MANUAL_UPI,
          ...settled,
        },
        { transaction }
      );
    }
    await group.update({ paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID }, { transaction });
    await MedicineOrder.update(
      { paymentStatus: MEDICINE_ORDER_PAYMENT_STATUS.PAID },
      { where: { orderGroupId: group.id }, transaction }
    );
    await MedicineNotification.create(
      {
        userId: group.patientId,
        title: "Payment received",
        message: `The pharmacy confirmed your UPI payment of ₹${money(group.totalAmount).toFixed(2)} for ${group.orderNumber}.`,
        type: "order_payment_received",
        referenceId: group.id,
        referenceType: "medicine_order_group",
      },
      { transaction }
    );
  });

  return exports.getGroupById(providerId, group.id);
};

/**
 * Which batches each line's units came from, read from the stock ledger (one
 * query for the whole order). A line sold from untracked stock has none.
 */
async function batchesForLines(lineIds) {
  if (!lineIds.length) return new Map();
  const rows = await MedicineStockMovement.findAll({
    where: {
      referenceType: STOCK_REFERENCE.ORDER_LINE,
      referenceId: { [Op.in]: lineIds },
      movementType: STOCK_MOVEMENT_TYPE.SALE,
      batchId: { [Op.ne]: null },
    },
    attributes: ["referenceId", "quantity"],
    include: [{ model: MedicineStockBatch, as: "batch", attributes: ["batchNumber", "expiryDate"] }],
    order: [["id", "ASC"]],
  });
  const map = new Map();
  for (const row of rows) {
    const key = String(row.referenceId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      batchNumber: row.batch?.batchNumber ?? null,
      expiryDate: row.batch?.expiryDate ?? null,
      quantity: -Number(row.quantity),
    });
  }
  return map;
}

/**
 * The bill. DERIVED from the order rather than duplicated into an invoice
 * table: the bill and the order can therefore never disagree, and there is no
 * second billing system to keep in sync. Readable only by the order's patient
 * or its pharmacy.
 *
 * Every figure was frozen on the order line when it was placed: selling price,
 * item discount, GST rate and the GST INCLUDED in the amount (prices are
 * GST-inclusive, so the tax is a breakdown of the total, not an addition).
 * Orders placed before GST data was recorded carry no tax breakdown —
 * `gstRecorded: false` — rather than an invented one. No delivery line is
 * emitted because the platform charges none.
 */
exports.getInvoice = async (userId, groupId) => {
  const group = await MedicineOrderGroup.findByPk(groupId, { include: GROUP_INCLUDE });
  if (!group) throw ApiError.notFound("Order not found");
  if (!sameId(group.patientId, userId) && !sameId(group.providerId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  const [payment, store, batchMap] = await Promise.all([
    MedicinePayment.findOne({ where: { orderGroupId: group.id }, order: [["createdAt", "DESC"]] }),
    settingsService.getStore(group.providerId),
    batchesForLines(group.items.map((i) => i.id)),
  ]);
  const data = serializeGroup(group);
  const gstRecorded = data.items.length > 0 && data.items.every((i) => i.taxableAmount !== null);

  return {
    invoiceNumber: data.orderNumber,
    issuedAt: data.placedAt || data.createdAt,
    orderNumber: data.orderNumber,
    orderStatus: data.status,
    patient: data.patient,
    provider: data.provider,
    providerType: data.providerType,
    /** The seller block of the bill: registered store + its GSTIN / licence. */
    store: store
      ? {
          name: store.name,
          phone: store.phone,
          email: store.email,
          addressLine: store.addressLine,
          city: store.city,
          state: store.state,
          pincode: store.pincode,
          gstin: store.gstin,
          drugLicenseNumber: store.drugLicenseNumber,
          invoiceNote: store.invoiceNote,
        }
      : null,
    deliveryAddress: data.deliveryAddress,
    deliveryCity: data.deliveryCity,
    deliveryState: data.deliveryState,
    deliveryPincode: data.deliveryPincode,
    prescriptionRequestId: data.prescriptionRequestId,
    lines: data.items.map((item) => ({
      medicineName: item.medicineName,
      strength: item.strength,
      packSize: item.packSize,
      hsnCode: item.hsnCode,
      batches: batchMap.get(String(item.id)) || [],
      quantity: item.quantity,
      returnedQuantity: item.returnedQuantity,
      mrp: item.mrp,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      discountAmount: item.discountAmount,
      gstRate: item.gstRate,
      taxableAmount: item.taxableAmount,
      gstAmount: item.gstAmount,
      lineTotal: item.lineTotal,
    })),
    subtotal: data.subtotal,
    discountTotal: data.discountTotal,
    taxableTotal: data.taxableTotal,
    gstTotal: data.gstTotal,
    gstRecorded,
    gstSummary: gstBreakup(data.items),
    total: data.totalAmount,
    returns: data.returns,
    refundedTotal: data.refundedTotal,
    netAfterReturns: money(data.totalAmount - data.refundedTotal),
    paymentMethod: data.paymentMethod,
    paymentStatus: data.paymentStatus,
    payment: payment
      ? {
          status: payment.status,
          gateway: payment.gateway,
          reference: payment.reference,
          paidAt: payment.paidAt,
          /** True while payments are simulated — the UI must say so on the bill. */
          simulated: payment.gateway === MEDICINE_PAYMENT_GATEWAY.SIMULATED,
        }
      : null,
  };
};

/**
 * The pharmacy's payment records — the EXISTING medicine_payments rows of its
 * own orders (one per attempt), newest first. Read-only: payments are settled
 * by checkout / the simulated online flow / COD delivery, never edited here.
 */
exports.getProviderPayments = async (providerId, { status, method, from, to, page = 1, limit = 20 } = {}) => {
  const where = {};
  if (status) where.status = status;
  if (method) where.method = method;
  if (from || to) {
    const bounds = istDateRangeBounds(from || "2000-01-01", to || "2999-12-31");
    where.createdAt = { [Op.gte]: bounds.from, [Op.lt]: bounds.to };
  }
  const { rows, count } = await MedicinePayment.findAndCountAll({
    where,
    include: [
      {
        model: MedicineOrderGroup,
        as: "group",
        attributes: ["id", "orderNumber", "status", "paymentStatus", "totalAmount", "patientId"],
        where: visibleToProviderWhere(providerId),
        required: true,
        include: [{ model: User, as: "patient", attributes: ["id", "name"] }],
      },
    ],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    payments: rows.map((p) => ({
      id: Number(p.id),
      orderGroupId: Number(p.orderGroupId),
      orderNumber: p.group?.orderNumber ?? null,
      orderStatus: p.group?.status ?? null,
      patientName: p.group?.patient?.name ?? null,
      amount: money(p.amount),
      method: p.method,
      status: p.status,
      gateway: p.gateway,
      simulated: p.gateway === MEDICINE_PAYMENT_GATEWAY.SIMULATED,
      reference: p.reference,
      /** UPI QR: what the patient reported paying (unverified), migration 044. */
      payerReference: p.payerReference ?? null,
      payerReportedAt: p.payerReportedAt ?? null,
      failureReason: p.failureReason,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    })),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};
