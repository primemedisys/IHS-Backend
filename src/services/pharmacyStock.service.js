/**
 * The ONLY writer of a pharmacy's stock. Every way a count can change — a
 * sale, its cancellation, a purchase, a return, an Excel import, a manual
 * correction, an expiry write-off — goes through here, so these three always
 * agree:
 *
 *   medicine_store_medicines.stock      the sellable total patients see
 *   medicine_stock_batches              where those units are, batch-wise
 *   medicine_stock_movements            why every unit moved (the ledger)
 *
 *   inventory.stock = Σ batch.quantity_available + UNTRACKED units
 *
 * "Untracked" units are stock with no batch number: everything that existed
 * before batch tracking, and anything a pharmacy enters without a batch. They
 * are never invented into a batch.
 *
 * Every function takes the caller's transaction and expects the inventory row
 * to be LOCKED (`lockInventories`) — rows are locked in id order and batches
 * after their inventory row, the same order everywhere, so two concurrent
 * stock operations can never deadlock each other.
 *
 * Expired batches are NOT sellable: a sale draws untracked units first (the
 * oldest stock in the shop), then batches first-expiry-first-out, and never
 * touches a batch whose expiry date has passed.
 */
const { Op } = require("sequelize");
const {
  MedicineStoreMedicine,
  MedicineStockBatch,
  MedicineStockMovement,
  MedicineNotification,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { istToday } = require("../utils/period");
const { ERROR_CODES } = require("../config/constants");
const { STOCK_MOVEMENT_TYPE, STOCK_REFERENCE } = require("../config/pharmacy");

/** Batch numbers compare case-insensitively; store them trimmed + upper-cased. */
function normalizeBatchNumber(value) {
  const cleaned = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return cleaned || null;
}

/** A batch is expired once its expiry date is before today (IST). */
const isExpired = (expiryDate, today = istToday()) => !!expiryDate && String(expiryDate).slice(0, 10) < today;

/** Earliest expiry first; batches without an expiry last; then oldest first. */
function byExpiry(a, b) {
  const ea = a.expiryDate ? String(a.expiryDate) : "9999-12-31";
  const eb = b.expiryDate ? String(b.expiryDate) : "9999-12-31";
  return ea === eb ? Number(a.id) - Number(b.id) : ea < eb ? -1 : 1;
}

const sumAvailable = (batches) => batches.reduce((n, b) => n + Number(b.quantityAvailable), 0);

/** Untracked units of an inventory row given ALL its batches (never negative). */
const untrackedOf = (inventory, batches) => Math.max(Number(inventory.stock) - sumAvailable(batches), 0);

/**
 * Lock inventory rows FOR UPDATE, in id order. With `providerId`, a row that
 * belongs to another pharmacy is treated as not found — ownership is enforced
 * here, not only in the route.
 *
 * @returns {Promise<Map<string, MedicineStoreMedicine>>}
 */
async function lockInventories(ids, transaction, { providerId } = {}) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return new Map();
  const where = { id: { [Op.in]: unique } };
  if (providerId) where.providerId = providerId;
  const rows = await MedicineStoreMedicine.findAll({
    where,
    order: [["id", "ASC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** Every batch of these inventory rows (locked when asked), grouped by inventory id. */
async function batchesByInventory(inventoryIds, transaction, { lock = true } = {}) {
  const ids = [...new Set(inventoryIds.map(String))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await MedicineStockBatch.findAll({
    where: { inventoryId: { [Op.in]: ids } },
    order: [["inventoryId", "ASC"], ["id", "ASC"]],
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  for (const row of rows) map.get(String(row.inventoryId)).push(row);
  return map;
}

/**
 * The nearest-expiring batch that still has stock — the summary the inventory
 * row carries for fast list filtering / sorting by expiry.
 */
function nearestBatch(batches) {
  const live = batches.filter((b) => Number(b.quantityAvailable) > 0).sort(byExpiry);
  return live[0] ? { batchNumber: live[0].batchNumber, expiryDate: live[0].expiryDate } : { batchNumber: null, expiryDate: null };
}

/**
 * Write the new total + nearest-batch summary to one locked inventory row.
 * Returns the stock level before the change (for low-stock crossing checks).
 */
async function saveInventory(inventory, batches, stock, transaction) {
  const before = Number(inventory.stock);
  await inventory.update({ stock, ...nearestBatch(batches) }, { transaction });
  return before;
}

const movementRow = (inventory, { batchId = null, type, quantity, stockAfter, ctx }) => ({
  providerId: inventory.providerId,
  inventoryId: inventory.id,
  batchId,
  movementType: type,
  quantity,
  stockAfter,
  referenceType: ctx.referenceType ?? null,
  referenceId: ctx.referenceId ?? null,
  note: ctx.note ? String(ctx.note).slice(0, 255) : null,
  createdBy: ctx.userId ?? null,
});

/**
 * Units IN: a purchase line, opening stock, or a manual receipt. With a batch
 * number the units land in that batch (created, or topped up — a batch has one
 * expiry, so a newly given expiry replaces the old); without one they are
 * untracked.
 *
 * @param {MedicineStoreMedicine} inventory  locked row
 * @param {{batchNumber?, expiryDate?, quantity, buyingPrice?, mrp?, supplierId?}} receipt
 * @param {{transaction, type, referenceType?, referenceId?, note?, userId?}} ctx
 * @returns {Promise<{batch: MedicineStockBatch|null, movement: object}>}
 */
async function receive(inventory, receipt, ctx) {
  const { transaction } = ctx;
  const quantity = Number(receipt.quantity) || 0;
  const batchNumber = normalizeBatchNumber(receipt.batchNumber);
  const batches = (await batchesByInventory([inventory.id], transaction)).get(String(inventory.id));

  let batch = null;
  if (batchNumber) {
    batch = batches.find((b) => b.batchNumber.toUpperCase() === batchNumber) || null;
    const details = {
      ...(receipt.expiryDate ? { expiryDate: receipt.expiryDate } : {}),
      ...(receipt.buyingPrice !== undefined && receipt.buyingPrice !== null ? { buyingPrice: receipt.buyingPrice } : {}),
      ...(receipt.mrp !== undefined && receipt.mrp !== null ? { mrp: receipt.mrp } : {}),
      ...(receipt.supplierId ? { supplierId: receipt.supplierId } : {}),
    };
    if (batch) {
      await batch.update(
        {
          ...details,
          quantityReceived: Number(batch.quantityReceived) + quantity,
          quantityAvailable: Number(batch.quantityAvailable) + quantity,
        },
        { transaction }
      );
    } else {
      batch = await MedicineStockBatch.create(
        {
          ...details,
          providerId: inventory.providerId,
          inventoryId: inventory.id,
          batchNumber,
          quantityReceived: quantity,
          quantityAvailable: quantity,
        },
        { transaction }
      );
      batches.push(batch);
    }
  }

  const stock = Number(inventory.stock) + quantity;
  await saveInventory(inventory, batches, stock, transaction);
  const movement = movementRow(inventory, { batchId: batch?.id ?? null, type: ctx.type, quantity, stockAfter: stock, ctx });
  await MedicineStockMovement.create(movement, { transaction });
  return { batch, movement };
}

/**
 * SET a quantity (manual correction / Excel import): the given batch's
 * available units — or, with no batch number, the untracked units — become
 * exactly `quantity`. Setting (not adding) is what makes re-importing the same
 * sheet idempotent. A batch that does not exist yet is created.
 *
 * @returns {Promise<{delta: number, batch: MedicineStockBatch|null}>}
 */
async function setQuantity(inventory, { batchNumber, quantity, expiryDate, buyingPrice, mrp, supplierId }, ctx) {
  const { transaction } = ctx;
  const target = Number(quantity) || 0;
  const number = normalizeBatchNumber(batchNumber);
  const batches = (await batchesByInventory([inventory.id], transaction)).get(String(inventory.id));

  let delta;
  let batch = null;
  if (number) {
    batch = batches.find((b) => b.batchNumber.toUpperCase() === number) || null;
    const details = {
      ...(expiryDate !== undefined ? { expiryDate: expiryDate || null } : {}),
      ...(buyingPrice !== undefined && buyingPrice !== null ? { buyingPrice } : {}),
      ...(mrp !== undefined && mrp !== null ? { mrp } : {}),
      ...(supplierId ? { supplierId } : {}),
    };
    if (batch) {
      delta = target - Number(batch.quantityAvailable);
      await batch.update(
        {
          ...details,
          quantityAvailable: target,
          quantityReceived: Math.max(Number(batch.quantityReceived) + Math.max(delta, 0), target),
        },
        { transaction }
      );
    } else {
      delta = target;
      batch = await MedicineStockBatch.create(
        {
          ...details,
          providerId: inventory.providerId,
          inventoryId: inventory.id,
          batchNumber: number,
          quantityReceived: target,
          quantityAvailable: target,
        },
        { transaction }
      );
      batches.push(batch);
    }
  } else {
    delta = target - untrackedOf(inventory, batches);
  }

  if (delta === 0 && !batch) return { delta, batch };
  const stock = Number(inventory.stock) + delta;
  await saveInventory(inventory, batches, stock, transaction);
  if (delta !== 0) {
    await MedicineStockMovement.create(
      movementRow(inventory, { batchId: batch?.id ?? null, type: ctx.type, quantity: delta, stockAfter: stock, ctx }),
      { transaction }
    );
  }
  return { delta, batch };
}

/**
 * Take back units a purchase put in (cancelling that purchase). Refused when
 * some of them have already been sold — the purchase is history by then, and
 * the shortfall is stated exactly.
 *
 * @param {{batchId: number|null, quantity: number, label: string}} receipt
 */
async function reverseReceipt(inventory, { batchId, quantity, label }, ctx) {
  const { transaction } = ctx;
  const batches = (await batchesByInventory([inventory.id], transaction)).get(String(inventory.id));
  const batch = batchId ? batches.find((b) => String(b.id) === String(batchId)) : null;
  const available = batch ? Number(batch.quantityAvailable) : untrackedOf(inventory, batches);
  if (available < quantity) {
    throw ApiError.conflict(
      `Cannot cancel: only ${available} of the ${quantity} unit(s) of ${label} are still in stock — the rest were already sold or adjusted`,
      { code: ERROR_CODES.STOCK_UNAVAILABLE }
    );
  }
  if (batch) {
    await batch.update(
      {
        quantityAvailable: available - quantity,
        quantityReceived: Math.max(Number(batch.quantityReceived) - quantity, 0),
      },
      { transaction }
    );
  }
  const stock = Number(inventory.stock) - quantity;
  await saveInventory(inventory, batches, stock, transaction);
  await MedicineStockMovement.create(
    movementRow(inventory, { batchId: batch?.id ?? null, type: ctx.type, quantity: -quantity, stockAfter: stock, ctx }),
    { transaction }
  );
}

/**
 * The pharmacy edits the TOTAL stock of an item (the long-standing "Stock"
 * field). Only the untracked part can absorb that change — batch quantities
 * are corrected batch by batch — so a total below what the batches hold is
 * refused with the exact figure.
 */
async function setTotalStock(inventory, total, ctx) {
  const batches = (await batchesByInventory([inventory.id], ctx.transaction)).get(String(inventory.id));
  const batched = sumAvailable(batches);
  if (Number(total) < batched) {
    throw ApiError.badRequest(
      `${batched} unit(s) of ${inventory.medicineName} are recorded in batches — reduce those batch quantities instead of the total`,
      { code: ERROR_CODES.VALIDATION_ERROR, details: { stock: [`Stock cannot be below the ${batched} unit(s) held in batches`] } }
    );
  }
  return setQuantity(inventory, { batchNumber: null, quantity: Number(total) - batched }, ctx);
}

/**
 * Units OUT for a sale. Draws untracked units first, then batches
 * first-expiry-first-out, skipping expired batches. Refuses — rolling back the
 * caller's whole order — when the in-date stock cannot cover the quantity.
 *
 * Returns the allocation and the ledger rows WITHOUT a reference id: the
 * caller creates the order line first and then calls `recordMovements` with
 * the line id, so the ledger always points at a real line.
 *
 * @returns {Promise<{allocations: Array<{batchId, batchNumber, expiryDate, quantity}>, movements: object[], stockBefore: number}>}
 */
async function allocateSale(inventory, quantity, ctx) {
  const { transaction } = ctx;
  const today = istToday();
  const batches = (await batchesByInventory([inventory.id], transaction)).get(String(inventory.id));
  const untracked = untrackedOf(inventory, batches);
  const sellable = batches.filter((b) => Number(b.quantityAvailable) > 0 && !isExpired(b.expiryDate, today)).sort(byExpiry);
  const expiredUnits = sumAvailable(batches.filter((b) => isExpired(b.expiryDate, today)));
  const available = untracked + sumAvailable(sellable);

  if (available < quantity) {
    throw ApiError.badRequest(
      expiredUnits > 0
        ? `Only ${available} of ${inventory.medicineName} are in stock and within expiry`
        : `Only ${available} of ${inventory.medicineName} are in stock`,
      { code: ERROR_CODES.STOCK_UNAVAILABLE }
    );
  }

  let remaining = quantity;
  let stock = Number(inventory.stock);
  const allocations = [];
  const movements = [];

  const fromUntracked = Math.min(untracked, remaining);
  if (fromUntracked > 0) {
    remaining -= fromUntracked;
    stock -= fromUntracked;
    allocations.push({ batchId: null, batchNumber: null, expiryDate: null, quantity: fromUntracked });
    movements.push(movementRow(inventory, { type: STOCK_MOVEMENT_TYPE.SALE, quantity: -fromUntracked, stockAfter: stock, ctx }));
  }
  for (const batch of sellable) {
    if (remaining === 0) break;
    const take = Math.min(Number(batch.quantityAvailable), remaining);
    remaining -= take;
    stock -= take;
    await batch.update({ quantityAvailable: Number(batch.quantityAvailable) - take }, { transaction });
    allocations.push({ batchId: batch.id, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity: take });
    movements.push(movementRow(inventory, { batchId: batch.id, type: STOCK_MOVEMENT_TYPE.SALE, quantity: -take, stockAfter: stock, ctx }));
  }

  const stockBefore = await saveInventory(inventory, batches, stock, transaction);
  return { allocations, movements, stockBefore };
}

/** Persist ledger rows prepared by allocateSale, stamped with their order line ids. */
function recordMovements(rows, transaction) {
  return rows.length ? MedicineStockMovement.bulkCreate(rows, { transaction }) : null;
}

/**
 * Put sold units back: a cancelled / rejected / payment-failed order
 * (everything outstanding) or a restocked return (`quantityByLine`).
 *
 * What is outstanding per line and batch is read from the LEDGER (sale rows
 * minus earlier reversals/returns), so units always return to exactly the
 * batch they left, and nothing can be put back twice. A line sold before the
 * ledger existed (no sale rows) goes back as untracked stock, which is
 * exactly how it was sold.
 *
 * @param {Array<{id, medicineId, quantity}>} lines   order lines (with inventory id)
 * @param {object} ctx  transaction + movement type + note/userId
 * @param {Map<string, number>} [quantityByLine]       cap per line (returns)
 * @returns {Promise<Map<string, number>>} restored quantity per line id
 */
async function restoreLines(lines, ctx, quantityByLine) {
  const { transaction } = ctx;
  const restored = new Map();
  if (!lines.length) return restored;

  const lineIds = lines.map((l) => l.id);
  const ledger = await MedicineStockMovement.findAll({
    where: { referenceType: STOCK_REFERENCE.ORDER_LINE, referenceId: { [Op.in]: lineIds } },
    attributes: ["referenceId", "batchId", "quantity", "movementType"],
    transaction,
  });

  // outstanding[lineId] = Map(batchKey -> units still out), batchKey "" = untracked
  const outstanding = new Map();
  const hasSaleRows = new Set();
  for (const row of ledger) {
    const lineKey = String(row.referenceId);
    if (row.movementType === STOCK_MOVEMENT_TYPE.SALE) hasSaleRows.add(lineKey);
    if (!outstanding.has(lineKey)) outstanding.set(lineKey, new Map());
    const byBatch = outstanding.get(lineKey);
    const batchKey = row.batchId ? String(row.batchId) : "";
    byBatch.set(batchKey, (byBatch.get(batchKey) || 0) - Number(row.quantity));
  }

  const inventories = await lockInventories(lines.map((l) => l.medicineId), transaction);
  const batchMap = await batchesByInventory([...inventories.keys()], transaction);

  const movements = [];
  const touched = new Map(); // inventory id -> new stock
  for (const line of [...lines].sort((a, b) => Number(a.medicineId) - Number(b.medicineId))) {
    const inventory = inventories.get(String(line.medicineId));
    if (!inventory) continue; // the inventory row was deleted — nothing to put back
    const lineKey = String(line.id);
    const batches = batchMap.get(String(inventory.id)) || [];
    let cap = quantityByLine ? Number(quantityByLine.get(lineKey) || 0) : Infinity;

    const buckets = hasSaleRows.has(lineKey)
      ? [...(outstanding.get(lineKey) || new Map()).entries()].filter(([, units]) => units > 0)
      : [["", Number(line.quantity)]];

    let stock = touched.has(String(inventory.id)) ? touched.get(String(inventory.id)) : Number(inventory.stock);
    let total = 0;
    for (const [batchKey, units] of buckets) {
      if (cap <= 0) break;
      const qty = Math.min(units, cap);
      cap -= qty;
      total += qty;
      stock += qty;
      const batch = batchKey ? batches.find((b) => String(b.id) === batchKey) : null;
      if (batch) await batch.update({ quantityAvailable: Number(batch.quantityAvailable) + qty }, { transaction });
      movements.push(
        movementRow(inventory, {
          batchId: batch?.id ?? null,
          type: ctx.type,
          quantity: qty,
          stockAfter: stock,
          ctx: { ...ctx, referenceType: STOCK_REFERENCE.ORDER_LINE, referenceId: line.id },
        })
      );
    }
    touched.set(String(inventory.id), stock);
    restored.set(lineKey, total);
  }

  for (const [inventoryId, stock] of touched) {
    await saveInventory(inventories.get(inventoryId), batchMap.get(inventoryId) || [], stock, transaction);
  }
  await recordMovements(movements, transaction);
  return restored;
}

/**
 * Remove expired units from sellable stock (they stay visible in the batch
 * history with quantity 0 and a write-off movement). Scoped to one pharmacy,
 * optionally to one inventory row.
 *
 * @returns {Promise<{batches: number, units: number}>}
 */
async function writeOffExpired(providerId, { inventoryId, userId, transaction }) {
  const where = {
    providerId,
    quantityAvailable: { [Op.gt]: 0 },
    expiryDate: { [Op.lt]: istToday() },
  };
  if (inventoryId) where.inventoryId = inventoryId;
  const expired = await MedicineStockBatch.findAll({ where, attributes: ["inventoryId"], transaction });
  if (!expired.length) return { batches: 0, units: 0 };

  const inventories = await lockInventories(expired.map((b) => b.inventoryId), transaction, { providerId });
  const batchMap = await batchesByInventory([...inventories.keys()], transaction);
  const today = istToday();
  const movements = [];
  let units = 0;
  let count = 0;
  for (const [id, inventory] of inventories) {
    const batches = batchMap.get(id);
    let stock = Number(inventory.stock);
    for (const batch of batches) {
      if (!isExpired(batch.expiryDate, today) || Number(batch.quantityAvailable) <= 0) continue;
      const qty = Number(batch.quantityAvailable);
      stock -= qty;
      units += qty;
      count += 1;
      await batch.update({ quantityAvailable: 0 }, { transaction });
      movements.push(
        movementRow(inventory, {
          batchId: batch.id,
          type: STOCK_MOVEMENT_TYPE.EXPIRY_WRITEOFF,
          quantity: -qty,
          stockAfter: stock,
          ctx: { userId, note: `Expired batch ${batch.batchNumber} (exp ${batch.expiryDate}) written off` },
        })
      );
    }
    await saveInventory(inventory, batches, stock, transaction);
  }
  await recordMovements(movements, transaction);
  return { batches: count, units };
}

/**
 * Low-stock / out-of-stock alerts for the pharmacy, raised only when a sale
 * CROSSES the item's reorder level (not on every sale below it), through the
 * existing medicine_notifications table.
 *
 * @param {Array<{inventory: MedicineStoreMedicine, before: number}>} changes
 */
async function notifyLowStock(changes, transaction) {
  const notices = [];
  for (const { inventory, before } of changes) {
    const after = Number(inventory.stock);
    const min = Number(inventory.minStock);
    if (after === 0 && before > 0) {
      notices.push({
        userId: inventory.providerId,
        title: "Out of stock",
        message: `${inventory.medicineName}${inventory.strength ? ` ${inventory.strength}` : ""} is now out of stock.`,
        type: "stock_out",
        referenceId: inventory.id,
        referenceType: "medicine_inventory",
      });
    } else if (after > 0 && after <= min && before > min) {
      notices.push({
        userId: inventory.providerId,
        title: "Low stock",
        message: `${inventory.medicineName}${inventory.strength ? ` ${inventory.strength}` : ""} is down to ${after} (reorder level ${min}).`,
        type: "stock_low",
        referenceId: inventory.id,
        referenceType: "medicine_inventory",
      });
    }
  }
  if (notices.length) await MedicineNotification.bulkCreate(notices, { transaction });
}

module.exports = {
  normalizeBatchNumber,
  isExpired,
  byExpiry,
  nearestBatch,
  untrackedOf,
  sumAvailable,
  lockInventories,
  batchesByInventory,
  receive,
  setQuantity,
  setTotalStock,
  reverseReceipt,
  allocateSale,
  recordMovements,
  restoreLines,
  writeOffExpired,
  notifyLowStock,
};
