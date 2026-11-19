/**
 * Supplier purchases (migration 043): the pharmacy records a supplier's
 * invoice and the stock goes IN — in one transaction, through the one stock
 * writer, so the purchase, the batches, the inventory totals and the ledger
 * can never disagree.
 *
 *   supplier → invoice → lines (medicine, batch, expiry, qty + free,
 *   buying price, discount %, GST %) → backend-computed totals → stock IN
 *
 * Each line updates the pharmacy's OWN inventory row for that medicine — the
 * existing row when it already stocks it, otherwise a new row linked to the
 * existing GLOBAL master (never a second medicine). Its buying price becomes
 * the latest purchase rate; MRP / selling price change only when the line
 * gives them.
 *
 * A purchase is never edited; it can be cancelled, which takes its units
 * back out — refused if some of them were already sold.
 */
const { Op, fn, col, where: sqlWhere } = require("sequelize");
const {
  sequelize,
  PharmacyPurchase,
  PharmacyPurchaseItem,
  PharmacySupplier,
  MedicineStoreMedicine,
  MedicineMaster,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { normalize } = require("../utils/medicineIdentity");
const { pricePurchaseLine, sumPurchaseLines, money } = require("../utils/medicinePricing");
const { documentNumber } = require("../utils/documentNumber");
const stockService = require("./pharmacyStock.service");
const supplierService = require("./pharmacySupplier.service");
const storeService = require("./medicineStore.service");
const { PURCHASE_STATUS, STOCK_MOVEMENT_TYPE, STOCK_REFERENCE, DOCUMENT_PREFIX } = require("../config/pharmacy");

const PURCHASE_INCLUDE = [
  { model: PharmacySupplier, as: "supplier", attributes: ["id", "name", "phone", "gstin"] },
  { model: PharmacyPurchaseItem, as: "items" },
];

function serialize(purchase) {
  const p = purchase.toJSON ? purchase.toJSON() : purchase;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    ...p,
    id: Number(p.id),
    supplierId: num(p.supplierId),
    subtotal: money(p.subtotal),
    discountTotal: money(p.discountTotal),
    taxableTotal: money(p.taxableTotal),
    gstTotal: money(p.gstTotal),
    totalAmount: money(p.totalAmount),
    items: (p.items || [])
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((i) => ({
        ...i,
        id: Number(i.id),
        inventoryId: num(i.inventoryId),
        batchId: num(i.batchId),
        buyingPrice: money(i.buyingPrice),
        mrp: num(i.mrp),
        sellingPrice: num(i.sellingPrice),
        gstRate: Number(i.gstRate),
        discountPercent: Number(i.discountPercent),
        grossAmount: money(i.grossAmount),
        discountAmount: money(i.discountAmount),
        taxableAmount: money(i.taxableAmount),
        gstAmount: money(i.gstAmount),
        lineTotal: money(i.lineTotal),
      })),
  };
}

/**
 * Resolve every line to a LOCKED inventory row of this pharmacy, creating a
 * row for a catalogue medicine it does not stock yet. Queries are per SET of
 * lines (Op.in), never per line.
 */
async function resolveInventories(providerId, providerType, items, transaction) {
  const inventoryIds = items.filter((i) => i.inventoryId).map((i) => i.inventoryId);
  const masterIds = [...new Set(items.filter((i) => i.medicineMasterId).map((i) => String(i.medicineMasterId)))];

  // Catalogue medicines: reuse this pharmacy's existing row for that master.
  const masterToInventory = new Map();
  if (masterIds.length) {
    const masters = await MedicineMaster.findAll({ where: { id: { [Op.in]: masterIds }, isActive: true }, transaction });
    if (masters.length !== masterIds.length) throw ApiError.badRequest("One or more medicines are not in the catalogue");
    const own = await MedicineStoreMedicine.findAll({
      where: { providerId, medicineMasterId: { [Op.in]: masterIds } },
      order: [["isActive", "DESC"], ["id", "ASC"]],
      transaction,
    });
    for (const row of own) {
      const key = String(row.medicineMasterId);
      if (!masterToInventory.has(key)) masterToInventory.set(key, row.id);
    }
    const location = await storeService.providerLocationLabel(providerId, transaction);
    for (const master of masters) {
      if (masterToInventory.has(String(master.id))) continue;
      const line = items.find((i) => String(i.medicineMasterId) === String(master.id));
      if (!line.sellingPrice) {
        throw ApiError.badRequest(`Enter a selling price for ${master.medicineName} — it is new to your inventory`, {
          details: { sellingPrice: ["Required for a medicine you do not stock yet"] },
        });
      }
      const created = await MedicineStoreMedicine.create(
        {
          providerId,
          providerType,
          medicineMasterId: master.id,
          medicineName: master.medicineName,
          genericName: master.genericName,
          medicineType: master.medicineType,
          strength: master.strength,
          manufacturer: master.manufacturer,
          description: master.description,
          categoryId: master.categoryId,
          price: line.sellingPrice,
          gstRate: line.gstRate || 0,
          stock: 0,
          location,
          isActive: true,
        },
        { transaction }
      );
      masterToInventory.set(String(master.id), created.id);
    }
  }

  const allIds = [...inventoryIds, ...masterToInventory.values()];
  const locked = await stockService.lockInventories(allIds, transaction, { providerId });
  for (const id of inventoryIds) {
    if (!locked.has(String(id))) throw ApiError.notFound("A medicine on this purchase is not in your inventory");
  }
  return items.map((item) => locked.get(String(item.inventoryId || masterToInventory.get(String(item.medicineMasterId)))));
}

exports.create = async (providerId, providerType, dto, userId = providerId) => {
  const purchaseId = await sequelize.transaction(async (transaction) => {
    if (dto.supplierId) await supplierService.findOwned(providerId, dto.supplierId, transaction);

    // The same supplier invoice can't be booked twice (a double entry would
    // double the stock). Compared case-insensitively.
    const duplicate = await PharmacyPurchase.findOne({
      where: {
        providerId,
        supplierId: dto.supplierId || null,
        status: PURCHASE_STATUS.RECEIVED,
        [Op.and]: [sqlWhere(fn("UPPER", col("invoice_number")), normalize(dto.invoiceNumber))],
      },
      attributes: ["id", "purchaseNumber"],
      transaction,
    });
    if (duplicate) {
      throw ApiError.conflict(`Invoice ${dto.invoiceNumber} is already recorded (${duplicate.purchaseNumber})`);
    }

    const inventories = await resolveInventories(providerId, providerType, dto.items, transaction);

    const priced = dto.items.map((item) => pricePurchaseLine(item));
    const totals = sumPurchaseLines(priced);

    const purchase = await PharmacyPurchase.create(
      {
        providerId,
        supplierId: dto.supplierId || null,
        invoiceNumber: dto.invoiceNumber.trim(),
        invoiceDate: dto.invoiceDate,
        status: PURCHASE_STATUS.RECEIVED,
        itemCount: dto.items.reduce((n, i) => n + i.quantity + (i.freeQuantity || 0), 0),
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxableTotal: totals.taxableTotal,
        gstTotal: totals.gstTotal,
        totalAmount: totals.total,
        notes: dto.notes || null,
        createdBy: userId,
      },
      { transaction }
    );
    await purchase.update({ purchaseNumber: documentNumber(DOCUMENT_PREFIX.PURCHASE, purchase.id) }, { transaction });

    const itemRows = await PharmacyPurchaseItem.bulkCreate(
      dto.items.map((item, i) => ({
        purchaseId: purchase.id,
        inventoryId: inventories[i].id,
        medicineMasterId: inventories[i].medicineMasterId,
        medicineName: [inventories[i].medicineName, inventories[i].strength].filter(Boolean).join(" "),
        batchNumber: stockService.normalizeBatchNumber(item.batchNumber),
        expiryDate: item.expiryDate || null,
        quantity: item.quantity,
        freeQuantity: item.freeQuantity || 0,
        buyingPrice: item.buyingPrice,
        mrp: item.mrp ?? null,
        sellingPrice: item.sellingPrice ?? null,
        gstRate: priced[i].gstRate,
        discountPercent: priced[i].discountPercent,
        grossAmount: priced[i].grossAmount,
        discountAmount: priced[i].discountAmount,
        taxableAmount: priced[i].taxableAmount,
        gstAmount: priced[i].gstAmount,
        lineTotal: priced[i].lineTotal,
      })),
      { transaction }
    );

    // Stock IN, line by line, through the one stock writer (each line is a
    // batch receipt referencing its purchase line in the ledger).
    for (let i = 0; i < dto.items.length; i += 1) {
      const item = dto.items[i];
      const inventory = inventories[i];
      const changes = { buyingPrice: item.buyingPrice };
      if (item.mrp) changes.mrp = item.mrp;
      if (item.sellingPrice) changes.price = item.sellingPrice;
      if (dto.supplierId) changes.supplierId = dto.supplierId;
      storeService.assertPriceWithinMrp({ price: changes.price ?? inventory.price, mrp: changes.mrp ?? inventory.mrp });
      await inventory.update({ ...changes, isActive: true }, { transaction });

      const { batch } = await stockService.receive(
        inventory,
        {
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate || null,
          quantity: item.quantity + (item.freeQuantity || 0),
          buyingPrice: item.buyingPrice,
          mrp: item.mrp,
          supplierId: dto.supplierId,
        },
        {
          transaction,
          type: STOCK_MOVEMENT_TYPE.PURCHASE,
          referenceType: STOCK_REFERENCE.PURCHASE_ITEM,
          referenceId: itemRows[i].id,
          note: `Purchase ${purchase.purchaseNumber} · invoice ${purchase.invoiceNumber}`,
          userId,
        }
      );
      if (batch) await itemRows[i].update({ batchId: batch.id }, { transaction });
    }
    return purchase.id;
  });

  return exports.get(providerId, purchaseId);
};

exports.get = async (providerId, id) => {
  const purchase = await PharmacyPurchase.findOne({ where: { id, providerId }, include: PURCHASE_INCLUDE });
  if (!purchase) throw ApiError.notFound("Purchase not found");
  return serialize(purchase);
};

/**
 * The pharmacy's purchases, filtered in the database: supplier, status,
 * invoice-date range (IST days), invoice / purchase number search, and
 * "purchases that contain this medicine".
 */
exports.list = async (providerId, { search, supplierId, status, from, to, inventoryId, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;
  if (from || to) where.invoiceDate = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    const matchingItems = await PharmacyPurchaseItem.findAll({
      where: { medicineName: like },
      include: [{ model: PharmacyPurchase, as: "purchase", attributes: [], where: { providerId }, required: true }],
      attributes: ["purchaseId"],
      group: ["purchaseId"],
      raw: true,
      limit: 1000,
    });
    where[Op.or] = [
      { invoiceNumber: like },
      { purchaseNumber: like },
      ...(matchingItems.length ? [{ id: { [Op.in]: matchingItems.map((r) => r.purchaseId) } }] : []),
    ];
  }
  if (inventoryId) {
    const rows = await PharmacyPurchaseItem.findAll({ where: { inventoryId }, attributes: ["purchaseId"], group: ["purchaseId"], raw: true });
    where.id = { [Op.in]: rows.map((r) => r.purchaseId) };
  }

  const { rows, count } = await PharmacyPurchase.findAndCountAll({
    where,
    include: [{ model: PharmacySupplier, as: "supplier", attributes: ["id", "name"] }],
    order: [["invoiceDate", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { purchases: rows.map(serialize), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/**
 * Cancel a purchase: every line's units come back OUT of the exact batch they
 * went into. All-or-nothing — if any line's units were already sold, nothing
 * changes and the reason is returned.
 */
exports.cancel = async (providerId, id, userId = providerId) => {
  await sequelize.transaction(async (transaction) => {
    const purchase = await PharmacyPurchase.findOne({
      where: { id, providerId },
      include: [{ model: PharmacyPurchaseItem, as: "items" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!purchase) throw ApiError.notFound("Purchase not found");
    if (purchase.status === PURCHASE_STATUS.CANCELLED) throw ApiError.conflict("This purchase is already cancelled");

    const inventories = await stockService.lockInventories(
      purchase.items.filter((i) => i.inventoryId).map((i) => i.inventoryId),
      transaction,
      { providerId }
    );
    for (const item of purchase.items) {
      const inventory = inventories.get(String(item.inventoryId));
      if (!inventory) continue; // the medicine was deleted from inventory since
      await stockService.reverseReceipt(
        inventory,
        { batchId: item.batchId, quantity: item.quantity + item.freeQuantity, label: item.medicineName },
        {
          transaction,
          type: STOCK_MOVEMENT_TYPE.PURCHASE_CANCEL,
          referenceType: STOCK_REFERENCE.PURCHASE_ITEM,
          referenceId: item.id,
          note: `Purchase ${purchase.purchaseNumber} cancelled`,
          userId,
        }
      );
    }
    await purchase.update({ status: PURCHASE_STATUS.CANCELLED, cancelledAt: new Date() }, { transaction });
  });
  return exports.get(providerId, id);
};

/** Header rows of recent purchases (dashboard). */
exports.recent = async (providerId, limit = 5) => {
  const rows = await PharmacyPurchase.findAll({
    where: { providerId, status: PURCHASE_STATUS.RECEIVED },
    include: [{ model: PharmacySupplier, as: "supplier", attributes: ["id", "name"] }],
    order: [["invoiceDate", "DESC"], ["id", "DESC"]],
    limit,
  });
  return rows.map(serialize);
};
