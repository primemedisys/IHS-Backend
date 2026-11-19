/**
 * The medicine cart. ONE cart per patient (`medicine_cart_items`), used by
 * both routes into an order — browsing the marketplace and picking medicines
 * off a pharmacy's prescription-availability answer. There is no second cart
 * and no client-side cart: the server is the only place a line exists.
 *
 * A line stores only (patient, provider inventory row, quantity). Price,
 * stock, provider and provider type are ALWAYS read live from
 * `medicine_store_medicines`, so:
 *   - provider A's medicine can never be priced at provider B's rate;
 *   - a price the provider changed after the item was added is reflected
 *     immediately, and the patient sees it before they pay;
 *   - a line whose stock ran out is flagged rather than silently ordered.
 *
 * Checkout re-validates all of it again under a row lock (medicineOrder
 * service) — nothing here is trusted as final.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  MedicineCartItem,
  MedicineStoreMedicine,
  MedicineCategory,
  PrescriptionRequestItem,
  PrescriptionRequest,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const { priceSaleLine, effectiveUnitPrice, sumSaleLines, money } = require("../utils/medicinePricing");
const { imagesByMaster } = require("./medicineMedia.service");
const paymentQrService = require("./paymentQr.service");
const {
  ERROR_CODES,
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  PRESCRIPTION_ITEM_STATUS,
} = require("../config/constants");

/** Hard cap on a single line, mirroring the order validator's max. */
const MAX_LINE_QUANTITY = 9999;

const MEDICINE_ATTRS = [
  "id",
  "providerId",
  "providerType",
  "medicineMasterId",
  "medicineName",
  "genericName",
  "medicineType",
  "strength",
  "manufacturer",
  "packSize",
  "price",
  "mrp",
  "discountPercent",
  "gstRate",
  "stock",
  "imageUrl",
  "isActive",
  "categoryId",
];

const LINE_INCLUDE = [
  {
    model: MedicineStoreMedicine,
    as: "medicine",
    attributes: MEDICINE_ATTRS,
    include: [
      { model: MedicineCategory, as: "category", attributes: ["id", "name", "slug"] },
      {
        model: User,
        as: "provider",
        attributes: ["id", "name", "role", "city", "state", "isActive"],
      },
    ],
  },
];

/**
 * Load the caller's OWN inventory-backed cart lines. Ownership is the
 * `patientId` filter — a patient can only ever read their own rows.
 */
function findLines(patientId, { transaction, lock } = {}) {
  return MedicineCartItem.findAll({
    where: { patientId },
    include: LINE_INCLUDE,
    order: [["createdAt", "ASC"]],
    transaction,
    ...(lock ? { lock } : {}),
  });
}

/**
 * Why a line cannot be ordered right now, or null when it can. One rule set,
 * used by both the cart read (to warn) and checkout (to reject), so the
 * warning the patient sees is exactly the condition that will block them.
 */
function lineBlocker(line) {
  const med = line.medicine;
  if (!med || !med.isActive) return "This medicine is no longer available";
  if (!med.provider?.isActive) return "This pharmacy is not accepting orders";
  if (med.stock <= 0) return "Out of stock";
  if (line.quantity > med.stock) return `Only ${med.stock} left in stock`;
  return null;
}

/**
 * Shape one line for the client: live price, live stock, and the line total
 * from the SAME pricing function checkout uses (selling price × qty, less the
 * pharmacy's item discount), so the cart shows exactly what will be charged.
 */
function serializeLine(line, images = new Map()) {
  const med = line.medicine;
  const priced = priceSaleLine(med || { price: 0 }, line.quantity);
  const unitPrice = priced.unitPrice;
  const mrp = med?.mrp === null || med?.mrp === undefined ? null : Number(med.mrp);
  // Saving against MRP is only claimed when the pharmacy recorded an MRP above
  // what the patient pays for this line.
  const mrpTotal = mrp ? money(mrp * line.quantity) : null;
  const mrpSavings = mrpTotal && mrpTotal > priced.lineTotal ? money(mrpTotal - priced.lineTotal) : 0;
  return {
    id: Number(line.id),
    medicineId: Number(line.medicineId),
    quantity: line.quantity,
    unitPrice,
    discountPercent: priced.discountPercent,
    discountAmount: priced.discountAmount,
    lineTotal: priced.lineTotal,
    gstRate: priced.gstRate,
    gstAmount: priced.gstAmount,
    mrpTotal,
    mrpSavings,
    /** The most the patient can set this line to right now (live stock). */
    maxQuantity: Math.max(Math.min(Number(med?.stock) || 0, MAX_LINE_QUANTITY), 0),
    prescriptionRequestId: line.prescriptionRequestId ? Number(line.prescriptionRequestId) : null,
    blocked: lineBlocker(line),
    medicine: med
      ? {
          id: Number(med.id),
          medicineName: med.medicineName,
          genericName: med.genericName,
          medicineType: med.medicineType,
          strength: med.strength,
          manufacturer: med.manufacturer,
          packSize: med.packSize ?? null,
          // The global medicine's primary photo first, the listing's own legacy image second.
          imageUrl: images.get(String(med.medicineMasterId))?.[0]?.imageUrl ?? med.imageUrl ?? null,
          price: unitPrice,
          effectivePrice: effectiveUnitPrice(med),
          mrp,
          discountPercent: priced.discountPercent,
          stock: med.stock,
          isActive: med.isActive,
          category: med.category ? { id: Number(med.category.id), name: med.category.name, slug: med.category.slug } : null,
        }
      : null,
    provider: med?.provider
      ? {
          id: Number(med.provider.id),
          name: med.provider.name,
          providerType: med.providerType,
          role: med.provider.role,
          city: med.provider.city,
          state: med.provider.state,
        }
      : null,
  };
}

/**
 * The cart, grouped BY PROVIDER — because a checkout is always against one
 * pharmacy (one order, one bill, one delivery). A cart holding two pharmacies'
 * medicines checks out as two orders, and the patient sees that split here
 * before they commit to it.
 */
exports.getCart = async (patientId) => {
  const rows = await findLines(patientId);
  const images = await imagesByMaster(rows.map((r) => r.medicine?.medicineMasterId));
  const lines = rows.map((row) => serializeLine(row, images));
  const orderable = lines.filter((l) => !l.blocked);

  const groups = new Map();
  for (const line of lines) {
    const key = String(line.provider?.id ?? "unknown");
    if (!groups.has(key)) {
      groups.set(key, { provider: line.provider, items: [], subtotal: 0, itemCount: 0 });
    }
    const group = groups.get(key);
    group.items.push(line);
    group.itemCount += line.quantity;
    if (!line.blocked) group.subtotal = Number((group.subtotal + line.lineTotal).toFixed(2));
  }

  const providerGroups = [...groups.values()];
  // Money totals count only orderable lines, so the figure shown is the figure
  // the backend would actually charge. Same summing function as the order.
  const totals = sumSaleLines(
    orderable.map((l) => ({
      grossAmount: money(l.unitPrice * l.quantity),
      discountAmount: l.discountAmount,
      lineTotal: l.lineTotal,
      taxableAmount: money(l.lineTotal - l.gstAmount),
      gstAmount: l.gstAmount,
    }))
  );
  return {
    items: lines,
    providerGroups,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    /** Selling price × quantity, before the pharmacies' item discounts. */
    grossTotal: totals.subtotal,
    /** The pharmacies' item discounts. */
    discountTotal: totals.discountTotal,
    subtotal: totals.total,
    /** GST already INCLUDED in the selling prices — a breakdown, never added on top. */
    gstIncluded: totals.gstTotal,
    /** Saving against MRP on the lines whose pharmacy recorded one. */
    mrpSavings: money(orderable.reduce((sum, l) => sum + l.mrpSavings, 0)),
    /** There is no delivery fee on this platform; stated so the summary never guesses one. */
    deliveryFee: 0,
    total: totals.total,
    hasBlockedItems: lines.some((l) => l.blocked),
  };
};

/** Just the badge number, so the navbar doesn't pull the whole cart. */
exports.getCount = async (patientId) => {
  const count = await MedicineCartItem.sum("quantity", { where: { patientId } });
  return { itemCount: Number(count || 0) };
};

/**
 * Which payment methods checkout can offer for this cart (migration 044).
 * UPI QR is offered only when EVERY pharmacy in the cart has its own QR set
 * up — checkout enforces the same rule. One query for the cart, one for the
 * QRs; the QR itself is never exposed here.
 */
exports.getPaymentOptions = async (patientId) => {
  const rows = await findLines(patientId);
  const providers = new Map();
  for (const row of rows) {
    const p = row.medicine?.provider;
    if (p && !providers.has(String(p.id))) providers.set(String(p.id), { providerId: Number(p.id), name: p.name });
  }
  const configured = await paymentQrService.configuredIds([...providers.keys()]);
  const list = [...providers.values()].map((p) => ({ ...p, upiQr: configured.has(String(p.providerId)) }));
  return {
    cod: true,
    upiQr: list.length > 0 && list.every((p) => p.upiQr),
    providers: list,
  };
};

/**
 * Load an orderable inventory row by id, or explain why it is not orderable.
 * This is the gate that keeps a deactivated MR listing (or any inactive
 * provider's listing) out of a NEW cart, while leaving historical orders and
 * the provider's own screens untouched.
 */
async function loadOrderableMedicine(medicineId, transaction) {
  const medicine = await MedicineStoreMedicine.findByPk(medicineId, {
    include: [{ model: User, as: "provider", attributes: ["id", "role", "isActive"] }],
    transaction,
  });
  if (!medicine || !medicine.isActive) throw ApiError.notFound("Medicine not found");
  if (!medicine.provider?.isActive) throw ApiError.badRequest("This pharmacy is not accepting orders");
  if (!ACTIVE_MEDICINE_PROVIDER_ROLES.includes(medicine.provider.role)) {
    throw ApiError.badRequest("This provider is no longer accepting new orders");
  }
  return medicine;
}

/**
 * Add a medicine to the cart, or raise the quantity when it is already there
 * (the (patient, medicine) pair is UNIQUE — one line per medicine, never a
 * duplicate row). Stock is checked against the RESULTING quantity.
 *
 * @param {number} patientId
 * @param {{medicineId: number|string, quantity?: number, prescriptionRequestId?: number|string}} dto
 */
exports.addItem = async (patientId, { medicineId, quantity = 1, prescriptionRequestId = null }) => {
  await sequelize.transaction(async (transaction) => {
    const medicine = await loadOrderableMedicine(medicineId, transaction);

    // A line may only be attributed to the patient's OWN shared prescription —
    // checkout later marks that request completed.
    if (prescriptionRequestId) {
      const pr = await PrescriptionRequest.findOne({
        where: { id: prescriptionRequestId, patientId },
        attributes: ["id"],
        transaction,
      });
      if (!pr) throw ApiError.notFound("Prescription not found");
    }

    const existing = await MedicineCartItem.findOne({
      where: { patientId, medicineId: medicine.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const nextQuantity = Math.min((existing?.quantity || 0) + quantity, MAX_LINE_QUANTITY);
    if (medicine.stock < nextQuantity) {
      throw ApiError.badRequest(
        existing
          ? `Only ${medicine.stock} of ${medicine.medicineName} are in stock — your cart already has ${existing.quantity}`
          : `Only ${medicine.stock} of ${medicine.medicineName} are in stock`,
        { code: ERROR_CODES.STOCK_UNAVAILABLE }
      );
    }

    if (existing) {
      await existing.update(
        {
          quantity: nextQuantity,
          // Keep the prescription link once set: a line that came off a shared
          // prescription stays attributable to it even if re-added from browse.
          prescriptionRequestId: existing.prescriptionRequestId || prescriptionRequestId || null,
        },
        { transaction }
      );
      return;
    }

    await MedicineCartItem.create(
      { patientId, medicineId: medicine.id, quantity: nextQuantity, prescriptionRequestId: prescriptionRequestId || null },
      { transaction }
    );
  });

  return exports.getCart(patientId);
};

/** Set an exact quantity on the caller's own line (0 removes it). */
exports.updateItem = async (patientId, itemId, quantity) => {
  const line = await MedicineCartItem.findOne({
    where: { id: itemId, patientId },
    include: LINE_INCLUDE,
  });
  if (!line) throw ApiError.notFound("Cart item not found");

  if (quantity <= 0) {
    await line.destroy();
    return exports.getCart(patientId);
  }
  if (!line.medicine || !line.medicine.isActive) throw ApiError.badRequest("This medicine is no longer available");
  if (!line.medicine.provider?.isActive) throw ApiError.badRequest("This pharmacy is not accepting orders");
  if (line.medicine.stock < quantity) {
    throw ApiError.badRequest(`Only ${line.medicine.stock} in stock`, { code: ERROR_CODES.STOCK_UNAVAILABLE });
  }

  await line.update({ quantity });
  return exports.getCart(patientId);
};

/** Remove one of the caller's own lines. */
exports.removeItem = async (patientId, itemId) => {
  const removed = await MedicineCartItem.destroy({ where: { id: itemId, patientId } });
  if (!removed) throw ApiError.notFound("Cart item not found");
  return exports.getCart(patientId);
};

/** Empty the caller's cart. */
exports.clear = async (patientId) => {
  await MedicineCartItem.destroy({ where: { patientId } });
  return exports.getCart(patientId);
};

/**
 * Validate a patient's selection against a pharmacy's stored availability
 * answer and turn it into orderable lines. ONE implementation, shared by
 * "add these to my cart" and "order these now", so the two can never disagree
 * about what a patient is allowed to take from a prescription.
 *
 * Each selection must belong to THIS patient's request, be marked `available`,
 * still point at a live inventory row, and stay within both the quantity the
 * pharmacy offered and the pharmacy's current stock. No price is read here:
 * the line points at the inventory row and checkout prices it.
 *
 * @param {number} patientId
 * @param {number|string} requestId
 * @param {Array<{itemId: number|string, quantity: number}>} selections
 */
exports.resolvePrescriptionSelections = async (patientId, requestId, selections) => {
  const request = await PrescriptionRequest.findByPk(requestId, {
    attributes: ["id", "patientId", "providerId", "status"],
  });
  if (!request) throw ApiError.notFound("Prescription request not found");
  if (!sameId(request.patientId, patientId)) throw ApiError.forbidden("Not authorized");

  const ids = selections.map((s) => s.itemId);
  const items = await PrescriptionRequestItem.findAll({
    where: {
      id: { [Op.in]: ids },
      prescriptionRequestId: request.id,
      status: PRESCRIPTION_ITEM_STATUS.AVAILABLE,
    },
    include: [{ model: MedicineStoreMedicine, as: "medicine", attributes: MEDICINE_ATTRS }],
  });
  if (items.length !== new Set(ids.map(String)).size) {
    throw ApiError.badRequest("One or more selected medicines are not available on this prescription");
  }
  const byId = new Map(items.map((i) => [String(i.id), i]));

  // Validate the WHOLE selection before anything is written, so a bad line
  // never leaves half a prescription in the cart.
  const plans = [];
  for (const selection of selections) {
    const item = byId.get(String(selection.itemId));
    if (!item.medicine || !item.medicine.isActive) {
      throw ApiError.badRequest(`${item.medicineName} is no longer available from this pharmacy`);
    }
    if (item.quantity != null && selection.quantity > item.quantity) {
      throw ApiError.badRequest(
        `The pharmacy can supply ${item.quantity} of ${item.medicineName}`,
        { code: ERROR_CODES.STOCK_UNAVAILABLE }
      );
    }
    if (item.medicine.stock < selection.quantity) {
      throw ApiError.badRequest(`Only ${item.medicine.stock} of ${item.medicineName} are in stock`, {
        code: ERROR_CODES.STOCK_UNAVAILABLE,
      });
    }
    plans.push({ medicineId: item.medicine.id, quantity: selection.quantity });
  }

  return { request, plans };
};

/**
 * Put the medicines a pharmacy marked `available` on a shared prescription
 * into the SAME cart the marketplace uses (no parallel prescription cart).
 * The patient then checks out through the one checkout.
 */
exports.addFromPrescription = async (patientId, requestId, selections) => {
  const { request, plans } = await exports.resolvePrescriptionSelections(patientId, requestId, selections);

  await sequelize.transaction(async (transaction) => {
    // One read of every existing line for these medicines (no query per row).
    const existing = await MedicineCartItem.findAll({
      where: { patientId, medicineId: { [Op.in]: plans.map((p) => p.medicineId) } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingByMedicine = new Map(existing.map((l) => [String(l.medicineId), l]));

    const toCreate = [];
    const updates = [];
    for (const plan of plans) {
      const line = existingByMedicine.get(String(plan.medicineId));
      if (line) {
        // Prescription quantities REPLACE rather than add: the patient is
        // stating what this prescription needs, not adding a second course.
        updates.push(line.update({ quantity: plan.quantity, prescriptionRequestId: request.id }, { transaction }));
      } else {
        toCreate.push({ ...plan, patientId, prescriptionRequestId: request.id });
      }
    }
    await Promise.all(updates);
    if (toCreate.length) await MedicineCartItem.bulkCreate(toCreate, { transaction });
  });

  return exports.getCart(patientId);
};

// Shared with the checkout path so "can this line be ordered?" is decided in
// exactly one place.
exports.lineBlocker = lineBlocker;
exports.findLines = findLines;
