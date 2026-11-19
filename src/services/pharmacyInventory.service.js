/**
 * Batch-level stock operations on a pharmacy's OWN inventory (migration 043):
 * receive stock without a purchase invoice, correct a batch, list batches by
 * expiry, write expired units off, and read an item's stock history.
 *
 * Ownership: every inventory row is loaded with `providerId` in the WHERE, so
 * another pharmacy's item is simply "not found". Every count change goes
 * through pharmacyStock.service (the one stock writer).
 */
const { Op } = require("sequelize");
const {
  sequelize,
  MedicineStoreMedicine,
  MedicineStockBatch,
  MedicineStockMovement,
  PharmacySupplier,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { istToday, addDays } = require("../utils/period");
const stockService = require("./pharmacyStock.service");
const settingsService = require("./pharmacySettings.service");
const storeService = require("./medicineStore.service");
const { STOCK_MOVEMENT_TYPE } = require("../config/pharmacy");

async function lockOwned(providerId, inventoryId, transaction) {
  const rows = await stockService.lockInventories([inventoryId], transaction, { providerId });
  const inventory = rows.get(String(inventoryId));
  if (!inventory) throw ApiError.notFound("Medicine not found");
  return inventory;
}

/** Units in hand without a supplier invoice (opening stock found, a transfer in …). */
exports.receiveStock = async (providerId, inventoryId, dto, userId = providerId) => {
  await sequelize.transaction(async (transaction) => {
    const inventory = await lockOwned(providerId, inventoryId, transaction);
    await stockService.receive(
      inventory,
      {
        batchNumber: dto.batchNumber,
        expiryDate: dto.expiryDate || null,
        quantity: dto.quantity,
        buyingPrice: dto.buyingPrice,
        mrp: dto.mrp,
      },
      { transaction, type: STOCK_MOVEMENT_TYPE.ADJUSTMENT, userId, note: dto.note || "Stock received (no purchase invoice)" }
    );
  });
  return storeService.getOne(providerId, inventoryId);
};

/** Correct one batch: its available units (set, not add) and/or its expiry date. */
exports.updateBatch = async (providerId, inventoryId, batchId, dto, userId = providerId) => {
  await sequelize.transaction(async (transaction) => {
    const inventory = await lockOwned(providerId, inventoryId, transaction);
    const batch = await MedicineStockBatch.findOne({
      where: { id: batchId, inventoryId: inventory.id, providerId },
      transaction,
    });
    if (!batch) throw ApiError.notFound("Batch not found");
    await stockService.setQuantity(
      inventory,
      {
        batchNumber: batch.batchNumber,
        quantity: dto.quantityAvailable ?? batch.quantityAvailable,
        ...(dto.expiryDate !== undefined ? { expiryDate: dto.expiryDate } : {}),
      },
      { transaction, type: STOCK_MOVEMENT_TYPE.ADJUSTMENT, userId, note: dto.note || `Batch ${batch.batchNumber} corrected` }
    );
  });
  return storeService.getOne(providerId, inventoryId);
};

/** One item's stock history, newest first (the ledger). */
exports.listMovements = async (providerId, inventoryId, { type, page = 1, limit = 20 } = {}) => {
  const inventory = await MedicineStoreMedicine.findOne({ where: { id: inventoryId, providerId }, attributes: ["id"] });
  if (!inventory) throw ApiError.notFound("Medicine not found");
  const where = { inventoryId, providerId };
  if (type) where.movementType = type;
  const { rows, count } = await MedicineStockMovement.findAndCountAll({
    where,
    include: [{ model: MedicineStockBatch, as: "batch", attributes: ["id", "batchNumber", "expiryDate"] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });

  // Who made each change, in one query.
  const userIds = [...new Set(rows.map((r) => r.createdBy).filter(Boolean).map(String))];
  const users = userIds.length ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ["id", "name", "role"] }) : [];
  const byId = new Map(users.map((u) => [String(u.id), u]));

  return {
    movements: rows.map((r) => {
      const author = byId.get(String(r.createdBy));
      return {
        ...r.toJSON(),
        // A patient's name is not the pharmacy's business here — sales show as "Order".
        actor: author ? (author.role === "patient" ? "Patient order" : author.name) : null,
      };
    }),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

/**
 * Batches across the whole inventory by expiry — the Expiry page. `status`:
 * expired (date passed), expiring (within `withinDays`, default = the
 * pharmacy's own window), valid (later), all.
 */
exports.listBatches = async (providerId, { status = "all", withinDays, inStockOnly = true, search, page = 1, limit = 20 } = {}) => {
  const today = istToday();
  const days = withinDays || (await settingsService.expiryAlertDays(providerId));
  const horizon = addDays(today, days);
  const where = { providerId };
  if (inStockOnly) where.quantityAvailable = { [Op.gt]: 0 };
  if (status === "expired") where.expiryDate = { [Op.lt]: today };
  else if (status === "expiring") where.expiryDate = { [Op.gte]: today, [Op.lte]: horizon };
  else if (status === "valid") where[Op.or] = [{ expiryDate: { [Op.gt]: horizon } }, { expiryDate: null }];

  const inventoryWhere = { providerId };
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    inventoryWhere[Op.or] = [{ medicineName: like }, { genericName: like }];
  }
  const { rows, count } = await MedicineStockBatch.findAndCountAll({
    where,
    include: [
      {
        model: MedicineStoreMedicine,
        as: "inventory",
        attributes: ["id", "medicineName", "strength", "medicineType", "price", "buyingPrice", "isActive"],
        where: inventoryWhere,
        required: true,
      },
      { model: PharmacySupplier, as: "supplier", attributes: ["id", "name"] },
    ],
    order: [[sequelize.literal("`MedicineStockBatch`.`expiry_date` IS NULL"), "ASC"], ["expiryDate", "ASC"], ["id", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    batches: rows.map((b) => {
      const plain = b.toJSON();
      const costRate = plain.buyingPrice ?? plain.inventory?.buyingPrice;
      return {
        ...plain,
        expiryStatus: storeService.expiryStatus(plain.expiryDate, today, days),
        daysToExpiry: plain.expiryDate
          ? Math.round((Date.parse(`${plain.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
          : null,
        /** Value of the units still in this batch at its buying price (NULL when unknown). */
        stockValue: costRate === null || costRate === undefined ? null : Number((Number(costRate) * plain.quantityAvailable).toFixed(2)),
      };
    }),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
    withinDays: days,
  };
};

exports.writeOffExpired = async (providerId, { inventoryId } = {}, userId = providerId) =>
  sequelize.transaction((transaction) => stockService.writeOffExpired(providerId, { inventoryId, userId, transaction }));
