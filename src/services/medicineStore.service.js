const { Op, UniqueConstraintError, where: sqlWhere, fn, col, literal } = require("sequelize");
const {
  sequelize,
  MedicineStoreMedicine,
  MedicineCategory,
  MedicineMaster,
  MedicineStockBatch,
  PharmacySupplier,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const {
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  ALL_MEDICINE_PROVIDER_ROLES,
  MEDICINE_PROVIDER_TYPE_LABELS,
  ERROR_CODES,
} = require("../config/constants");
const { STOCK_MOVEMENT_TYPE } = require("../config/pharmacy");
const { cleanDisplay, normalize, medicineIdentityKey } = require("../utils/medicineIdentity");
const { effectiveUnitPrice, unitMargin, money } = require("../utils/medicinePricing");
const { istToday, addDays } = require("../utils/period");
const medicineMediaService = require("./medicineMedia.service");
const stockService = require("./pharmacyStock.service");
const settingsService = require("./pharmacySettings.service");

/**
 * Which provider roles the PUBLIC / patient surfaces sell from. MR is absent
 * (migration 036): a Medicine Representative can still sign in, manage its own
 * inventory and read its own history, but it is no longer offered to patients
 * as somewhere to buy from or share a prescription with.
 */
const PROVIDER_ROLES = ACTIVE_MEDICINE_PROVIDER_ROLES;

/**
 * Fields a provider may set on THEIR OWN inventory row. Everything else is the
 * global master's and can't be changed through an inventory edit. `stock` is
 * deliberately absent: it only ever changes through pharmacyStock.service, so
 * the batch split and the stock ledger can never drift from the total.
 */
const INVENTORY_FIELDS = [
  "price",
  "mrp",
  "buyingPrice",
  "gstRate",
  "discountPercent",
  "minStock",
  "sku",
  "hsnCode",
  "packSize",
  "supplierId",
  "location",
  "imageUrl",
  "isActive",
];

/**
 * Inventory columns that are the PHARMACY'S business and never a patient's:
 * its purchase cost, its supplier, its reorder level, its internal code and
 * its batch summary. Every public read excludes these.
 */
const PRIVATE_INVENTORY_ATTRS = ["buyingPrice", "supplierId", "minStock", "sku", "batchNumber", "expiryDate"];

const CATEGORY_ATTRS = ["id", "name", "slug"];
const MASTER_ATTRS = ["id", "medicineName", "genericName", "medicineType", "strength", "manufacturer", "description", "categoryId"];
const SUPPLIER_ATTRS = ["id", "name", "phone"];
const BATCH_ATTRS = ["id", "batchNumber", "expiryDate", "quantityReceived", "quantityAvailable", "buyingPrice", "mrp", "supplierId", "createdAt", "updatedAt"];
/** What a patient may see about a provider: identity + registered location, nothing private. */
const PUBLIC_PROVIDER_ATTRS = ["id", "name", "role", "profilePhotoUrl", "city", "state"];

const pick = (obj, keys) =>
  keys.reduce((acc, k) => (obj[k] !== undefined ? { ...acc, [k]: obj[k] } : acc), {});

/** Case-insensitive equality on a column, independent of the table collation. */
const ciEquals = (column, value) => sqlWhere(fn("UPPER", col(column)), normalize(value));

/**
 * Structured location filter on the provider (users) row — the same
 * city + state convention the share-prescription provider search uses.
 * Case-insensitive; exact (no substring) so "Cuttack" never matches "Bhubaneswar".
 */
function providerLocationWhere({ city, state }) {
  const clauses = [];
  if (city) clauses.push(ciEquals("provider.city", city));
  if (state) clauses.push(ciEquals("provider.state", state));
  return clauses;
}

/**
 * Patient-facing price fields of a listing: what one unit costs after the item
 * discount, and the saving against the price it is compared with.
 *
 * The comparison price is the MRP when the pharmacy recorded one (Indian retail
 * convention), otherwise the pre-discount selling price when an item discount
 * is set. With neither there is no saving to claim, so none is returned. The
 * percentage is floored so it can never overstate the real saving.
 */
const publicPricing = (row) => {
  const effectivePrice = effectiveUnitPrice(row);
  const discountPercent = Number(row.discountPercent || 0);
  const mrp = row.mrp === null || row.mrp === undefined ? null : Number(row.mrp);
  const compareAt = mrp && mrp > effectivePrice ? mrp : discountPercent > 0 ? Number(row.price) : null;
  const savingsAmount = compareAt ? money(compareAt - effectivePrice) : 0;
  return {
    effectivePrice,
    discountPercent,
    mrp,
    compareAtPrice: savingsAmount > 0 ? compareAt : null,
    savingsAmount,
    savingsPercent: savingsAmount > 0 ? Math.floor((savingsAmount / compareAt) * 100) : 0,
  };
};

// ── Patient search ────────────────────────────────────────────────────────

/** LIKE-safe: `%`, `_` and `\` typed by a patient match themselves, not "anything". */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * "Zerodol-SP 100mg" → ["zerodol", "sp", "100mg"]. Splitting on punctuation is
 * what lets "Zerodol-SP" find a listing stored as "Zerodol Sp".
 */
const searchTokens = (search) =>
  String(search || "")
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
    .slice(0, 6);

/** Fields a patient's search matches on (the listing's copy of the global medicine). */
const SEARCH_FIELDS = ["medicineName", "genericName", "manufacturer", "strength"];

/** Every token must match one searchable field (AND of ORs). */
function listingSearchWhere(search) {
  return searchTokens(search).map((token) => ({
    [Op.or]: SEARCH_FIELDS.map((field) => ({ [field]: { [Op.like]: `%${escapeLike(token)}%` } })),
  }));
}

// Listing-level SQL expressions for sort / price filter. The alias is the
// model name, which is what Sequelize uses for the root table of a query with
// includes. The effective price mirrors priceSaleLine for one unit.
const L = "`MedicineStoreMedicine`";
const EFFECTIVE_PRICE_SQL = `ROUND(${L}.\`price\` * (100 - ${L}.\`discount_percent\`) / 100, 2)`;
const SAVINGS_RATIO_SQL = `((COALESCE(${L}.\`mrp\`, ${L}.\`price\`) - ${EFFECTIVE_PRICE_SQL}) / COALESCE(${L}.\`mrp\`, ${L}.\`price\`))`;
const DISCOUNT_PERCENT_SQL = `COALESCE(${L}.\`discount_percent\`, 0)`;
const IN_STOCK_FIRST = [literal(`(${L}.\`stock\` > 0)`), "DESC"];

/** Name-prefix matches rank above mid-word matches. */
const prefixFirst = (search) => {
  const first = searchTokens(search)[0];
  return first ? [[literal(`(${L}.\`medicine_name\` LIKE ${sequelize.escape(`${escapeLike(first)}%`)})`), "DESC"]] : [];
};

const BROWSE_SORTS = {
  relevance: (search) => [IN_STOCK_FIRST, ...prefixFirst(search), ["createdAt", "DESC"]],
  price_asc: () => [IN_STOCK_FIRST, [literal(EFFECTIVE_PRICE_SQL), "ASC"], ["id", "ASC"]],
  price_desc: () => [IN_STOCK_FIRST, [literal(EFFECTIVE_PRICE_SQL), "DESC"], ["id", "ASC"]],
  discount: () => [IN_STOCK_FIRST, [literal(SAVINGS_RATIO_SQL), "DESC"], ["id", "ASC"]],
  name: () => [["medicineName", "ASC"], ["id", "ASC"]],
};

// ── Provider (MR / Store) inventory ───────────────────────────────────────

/** "out" (0), "low" (1..reorder level) or "in". */
function stockStatus(row) {
  const stock = Number(row.stock);
  if (stock <= 0) return "out";
  return stock <= Number(row.minStock) ? "low" : "in";
}

/** Expiry state of the nearest-expiring batch that still has stock (null = no batch data). */
function expiryStatus(expiryDate, today, alertDays) {
  if (!expiryDate) return null;
  const day = String(expiryDate).slice(0, 10);
  if (day < today) return "expired";
  return day <= addDays(today, alertDays) ? "expiring" : "ok";
}

/**
 * The provider's view of one inventory row: everything stored plus the
 * figures derived from it (effective price, per-unit gross margin, stock and
 * expiry state). Derived here, from real columns, never stored twice.
 */
function serializeInventory(row, { today, alertDays }) {
  const plain = row.toJSON ? row.toJSON() : row;
  return {
    ...plain,
    effectivePrice: effectiveUnitPrice(plain),
    unitMargin: unitMargin(plain),
    stockStatus: stockStatus(plain),
    expiryStatus: expiryStatus(plain.expiryDate, today, alertDays),
  };
}

/**
 * The provider's inventory, filtered, sorted and paginated IN THE DATABASE.
 * `active` defaults to "active" — the long-standing behaviour of this list.
 */
exports.listMyMedicines = async (
  providerId,
  { search, category, form, stockStatus: stockFilter, expiry, supplierId, active = "active", sort = "name", order = "asc", page = 1, limit = 20 } = {}
) => {
  const where = { providerId };
  const and = [];
  if (active === "active") where.isActive = true;
  else if (active === "inactive") where.isActive = false;
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [{ medicineName: like }, { genericName: like }, { manufacturer: like }, { sku: like }, { batchNumber: like }];
  }
  if (category) where.categoryId = category;
  if (form) where.medicineType = form;
  if (supplierId) where.supplierId = supplierId;

  if (stockFilter === "out") where.stock = 0;
  else if (stockFilter === "low") {
    where.stock = { [Op.gt]: 0 };
    and.push(sqlWhere(col("MedicineStoreMedicine.stock"), Op.lte, col("MedicineStoreMedicine.min_stock")));
  } else if (stockFilter === "in") {
    and.push(sqlWhere(col("MedicineStoreMedicine.stock"), Op.gt, col("MedicineStoreMedicine.min_stock")));
  }

  const today = istToday();
  const alertDays = await settingsService.expiryAlertDays(providerId);
  if (expiry === "expired") where.expiryDate = { [Op.lt]: today };
  else if (expiry === "expiring") where.expiryDate = { [Op.gte]: today, [Op.lte]: addDays(today, alertDays) };
  else if (expiry === "valid") where.expiryDate = { [Op.gt]: addDays(today, alertDays) };
  else if (expiry === "none") where.expiryDate = null;
  if (and.length) where[Op.and] = and;

  const direction = order === "desc" ? "DESC" : "ASC";
  const ORDER = {
    name: [["medicineName", direction], ["id", "ASC"]],
    stock: [["stock", direction], ["medicineName", "ASC"]],
    price: [["price", direction], ["medicineName", "ASC"]],
    // Rows without batch data sort last whichever way the dates run.
    expiry: [[literal("`MedicineStoreMedicine`.`expiry_date` IS NULL"), "ASC"], ["expiryDate", direction], ["medicineName", "ASC"]],
    updated: [["updatedAt", direction], ["id", "DESC"]],
  };

  const safeLimit = Math.min(limit, 100);
  const { rows, count } = await MedicineStoreMedicine.findAndCountAll({
    where,
    include: [
      { model: MedicineCategory, as: "category", attributes: CATEGORY_ATTRS },
      { model: PharmacySupplier, as: "supplier", attributes: SUPPLIER_ATTRS },
    ],
    order: ORDER[sort] || ORDER.name,
    limit: safeLimit,
    offset: (page - 1) * safeLimit,
    distinct: true,
  });

  // One query for the page's primary images (global master photos).
  const images = await medicineMediaService.imagesByMaster(rows.map((r) => r.medicineMasterId));
  const medicines = rows.map((row) => ({
    ...serializeInventory(row, { today, alertDays }),
    primaryImageUrl: images.get(String(row.medicineMasterId))?.[0]?.imageUrl ?? row.imageUrl ?? null,
  }));

  return { medicines, total: count, page, limit: safeLimit, totalPages: Math.ceil(count / safeLimit) };
};

/** The bare inventory row the caller owns (ownership is the providerId filter). */
async function findOwned(providerId, id, { transaction, lock } = {}) {
  const med = await MedicineStoreMedicine.findOne({
    where: { id, providerId },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!med) throw ApiError.notFound("Medicine not found");
  return med;
}

exports.getOne = async (providerId, id) => {
  const med = await MedicineStoreMedicine.findOne({
    where: { id, providerId },
    include: [
      { model: MedicineCategory, as: "category", attributes: CATEGORY_ATTRS },
      { model: MedicineMaster, as: "master", attributes: MASTER_ATTRS },
      { model: PharmacySupplier, as: "supplier", attributes: SUPPLIER_ATTRS },
      { model: MedicineStockBatch, as: "batches", attributes: BATCH_ATTRS, include: [{ model: PharmacySupplier, as: "supplier", attributes: ["id", "name"] }] },
    ],
  });
  if (!med) throw ApiError.notFound("Medicine not found");

  const today = istToday();
  const alertDays = await settingsService.expiryAlertDays(providerId);
  const plain = serializeInventory(med, { today, alertDays });
  const batches = [...(plain.batches || [])].sort(stockService.byExpiry).map((b) => ({
    ...b,
    expiryStatus: expiryStatus(b.expiryDate, today, alertDays),
  }));
  return {
    ...plain,
    batches,
    untrackedStock: stockService.untrackedOf(plain, batches),
    expiryAlertDays: alertDays,
  };
};

/**
 * Resolve the global master for a new inventory row: the one the provider
 * picked, or — for "Add New Medicine" — the existing master with the same
 * case-insensitive NAME|STRENGTH|TYPE identity, creating it only when none
 * exists. A provider typing an existing medicine again therefore reuses it.
 */
async function resolveMaster(providerId, dto, transaction, { role = null } = {}) {
  if (dto.medicineMasterId) {
    const master = await MedicineMaster.findOne({
      where: { id: dto.medicineMasterId, isActive: true },
      transaction,
    });
    if (!master) throw ApiError.notFound("Medicine not found in the catalogue");
    return master;
  }

  if (dto.categoryId) {
    const category = await MedicineCategory.findByPk(dto.categoryId, { attributes: ["id"], transaction });
    if (!category) throw ApiError.badRequest("Selected category does not exist");
  }

  const identityKey = medicineIdentityKey(dto);
  const existing = await MedicineMaster.findOne({ where: { identityKey }, transaction });
  if (existing) return existing;

  try {
    return await MedicineMaster.create(
      {
        medicineName: cleanDisplay(dto.medicineName),
        genericName: dto.genericName ? cleanDisplay(dto.genericName) : null,
        medicineType: cleanDisplay(dto.medicineType),
        strength: dto.strength ? cleanDisplay(dto.strength) : null,
        manufacturer: dto.manufacturer ? cleanDisplay(dto.manufacturer) : null,
        description: dto.description || null,
        categoryId: dto.categoryId || null,
        identityKey,
        createdBy: providerId,
        createdByRole: role,
      },
      { transaction }
    );
  } catch (err) {
    // Another provider created the same identity a moment ago — use theirs.
    if (err instanceof UniqueConstraintError) {
      const raced = await MedicineMaster.findOne({ where: { identityKey }, transaction });
      if (raced) return raced;
    }
    throw err;
  }
}

/** Default inventory location text: the provider's registered Google city/state. */
async function providerLocationLabel(providerId, transaction) {
  const provider = await User.findByPk(providerId, { attributes: ["city", "state"], transaction });
  return [provider?.city, provider?.state].filter(Boolean).join(", ") || null;
}

/** A supplier id must be one of THIS pharmacy's suppliers. */
async function assertOwnSupplier(providerId, supplierId, transaction) {
  if (!supplierId) return;
  const supplier = await PharmacySupplier.findOne({ where: { id: supplierId, providerId }, attributes: ["id"], transaction });
  if (!supplier) throw ApiError.badRequest("Selected supplier does not exist", { details: { supplierId: ["Unknown supplier"] } });
}

/**
 * Selling above the printed MRP is refused. Checked against the RESULTING row
 * (an edit may change only one of the two), which a Joi schema cannot see.
 */
function assertPriceWithinMrp({ price, mrp }) {
  if (mrp === null || mrp === undefined || mrp === "") return;
  if (Number(price) > Number(mrp)) {
    throw ApiError.badRequest("Selling price cannot be more than the MRP", {
      code: ERROR_CODES.VALIDATION_ERROR,
      details: { price: [`Selling price ₹${money(price)} is above the MRP ₹${money(mrp)}`] },
    });
  }
}

/**
 * Add a medicine to the provider's OWN inventory. Creates/links the global
 * master, then creates only this provider's inventory row (own price/stock).
 * If the provider already sells that master, an active row is a conflict and
 * an inactive (removed) row is re-activated with the new price/stock.
 *
 * Opening stock goes through the stock service: into `batchNumber` when one
 * is given (with its expiry), otherwise as untracked units. No image is
 * needed — photos are added to the global medicine afterwards, if at all.
 */
exports.create = async (providerId, providerType, dto, userId = providerId) => {
  assertPriceWithinMrp(dto);
  const inventoryId = await sequelize.transaction(async (transaction) => {
    await assertOwnSupplier(providerId, dto.supplierId, transaction);
    const master = await resolveMaster(providerId, dto, transaction);

    const own = await MedicineStoreMedicine.findAll({
      where: { providerId, medicineMasterId: master.id },
      order: [["isActive", "DESC"], ["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (own.some((row) => row.isActive)) {
      throw ApiError.conflict(
        `${master.medicineName} is already in your medicines — edit its price or stock instead`
      );
    }

    const inventory = pick(dto, INVENTORY_FIELDS);
    if (!inventory.location) inventory.location = await providerLocationLabel(providerId, transaction);
    const snapshot = {
      medicineMasterId: master.id,
      medicineName: master.medicineName,
      genericName: master.genericName,
      medicineType: master.medicineType,
      strength: master.strength,
      manufacturer: master.manufacturer,
      description: master.description,
      categoryId: master.categoryId,
    };

    const opening = {
      batchNumber: dto.batchNumber,
      expiryDate: dto.expiryDate || null,
      quantity: dto.stock || 0,
      buyingPrice: dto.buyingPrice,
      mrp: dto.mrp,
      supplierId: dto.supplierId,
    };
    const ctx = { transaction, type: STOCK_MOVEMENT_TYPE.OPENING, userId, note: "Opening stock" };

    if (own.length) {
      // Re-adding a removed medicine: its stock becomes what was entered now.
      const row = own[0];
      await row.update({ ...snapshot, ...inventory, isActive: true }, { transaction });
      await stockService.setQuantity(row, opening, { ...ctx, type: STOCK_MOVEMENT_TYPE.ADJUSTMENT, note: "Re-added to inventory" });
      return row.id;
    }
    const created = await MedicineStoreMedicine.create(
      { ...snapshot, ...inventory, stock: 0, isActive: true, providerId, providerType },
      { transaction }
    );
    if (opening.quantity > 0 || stockService.normalizeBatchNumber(opening.batchNumber)) {
      await stockService.receive(created, opening, ctx);
    }
    return created.id;
  });

  return exports.getOne(providerId, inventoryId);
};

/**
 * Update ONLY provider-specific fields on the caller's own row. A new `stock`
 * is a manual correction of the TOTAL and is applied to the untracked units
 * through the stock service (batches are corrected individually).
 */
exports.update = async (providerId, id, dto, userId = providerId) => {
  const changes = pick(dto, INVENTORY_FIELDS);
  const hasStock = dto.stock !== undefined;
  if (!Object.keys(changes).length && !hasStock) {
    throw ApiError.badRequest("Nothing to update");
  }

  await sequelize.transaction(async (transaction) => {
    const med = await findOwned(providerId, id, { transaction, lock: true });
    assertPriceWithinMrp({
      price: changes.price ?? med.price,
      mrp: changes.mrp !== undefined ? changes.mrp : med.mrp,
    });
    await assertOwnSupplier(providerId, changes.supplierId, transaction);
    if (Object.keys(changes).length) await med.update(changes, { transaction });
    if (hasStock && Number(dto.stock) !== Number(med.stock)) {
      await stockService.setTotalStock(med, dto.stock, {
        transaction,
        type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
        userId,
        note: dto.stockNote || "Manual stock correction",
      });
    }
  });
  return exports.getOne(providerId, id);
};

exports.remove = async (providerId, id) => {
  const med = await findOwned(providerId, id);
  await med.update({ isActive: false });
  return { id: String(id) };
};

exports.PRIVATE_INVENTORY_ATTRS = PRIVATE_INVENTORY_ATTRS;
exports.INVENTORY_FIELDS = INVENTORY_FIELDS;
exports.resolveMaster = resolveMaster;
exports.assertOwnSupplier = assertOwnSupplier;
exports.assertPriceWithinMrp = assertPriceWithinMrp;
exports.providerLocationLabel = providerLocationLabel;
exports.stockStatus = stockStatus;
exports.expiryStatus = expiryStatus;
exports.serializeInventory = serializeInventory;

// ── Global medicine master search (MR / Store "Search Existing Medicine") ──

exports.searchMasters = async (providerId, { search, categoryId, limit = 20 } = {}) => {
  const where = { isActive: true };
  if (search) {
    // Table collation is case-insensitive, so LIKE matches "jerodol" / "JERODOL".
    where[Op.or] = [
      { medicineName: { [Op.like]: `%${cleanDisplay(search)}%` } },
      { genericName: { [Op.like]: `%${cleanDisplay(search)}%` } },
    ];
  }
  if (categoryId) where.categoryId = categoryId;

  const masters = await MedicineMaster.findAll({
    where,
    attributes: MASTER_ATTRS,
    include: [{ model: MedicineCategory, as: "category", attributes: CATEGORY_ATTRS }],
    order: [["medicineName", "ASC"], ["strength", "ASC"]],
    limit: Math.min(limit, 50),
  });

  // Flag the ones the caller already sells, in ONE query (no per-row lookups).
  const ids = masters.map((m) => m.id);
  const mine = ids.length
    ? await MedicineStoreMedicine.findAll({
        where: { providerId, medicineMasterId: { [Op.in]: ids }, isActive: true },
        attributes: ["id", "medicineMasterId"],
      })
    : [];
  const mineByMaster = new Map(mine.map((m) => [String(m.medicineMasterId), m.id]));

  return masters.map((m) => ({
    ...m.toJSON(),
    inMyInventory: mineByMaster.has(String(m.id)),
    myInventoryId: mineByMaster.get(String(m.id)) ?? null,
  }));
};

// ── Patient / public marketplace ──────────────────────────────────────────

/**
 * Provider-specific inventory rows: the same global medicine appears once per
 * provider selling it, each with that provider's own price, stock and
 * registered location. Location filters on the PROVIDER's structured
 * city/state (users table), not on free text.
 */
exports.browseMedicines = async ({
  search,
  category,
  location,
  city,
  state,
  providerType,
  availability,
  minPrice,
  maxPrice,
  providerId,
  minDiscount,
  sort = "relevance",
  page = 1,
  limit = 20,
} = {}) => {
  const where = { isActive: true };
  // One store's shelf (the mobile store page). The provider join below still
  // applies, so an inactive / retired provider's listings stay hidden.
  if (providerId) where.providerId = providerId;
  const and = listingSearchWhere(search);
  // On the item discount — exactly the `discountPercent` publicPricing returns
  // (`Number(row.discountPercent || 0)`), so no row shows less than asked for.
  if (minDiscount) and.push(sqlWhere(literal(DISCOUNT_PERCENT_SQL), Op.gte, minDiscount));
  // Price range is on what the patient actually pays (after the item discount).
  if (minPrice !== undefined && minPrice !== null) and.push(sqlWhere(literal(EFFECTIVE_PRICE_SQL), Op.gte, minPrice));
  if (maxPrice !== undefined && maxPrice !== null) and.push(sqlWhere(literal(EFFECTIVE_PRICE_SQL), Op.lte, maxPrice));
  // Still accepted for old links; the patient screens no longer send it.
  if (category) where.categoryId = category;
  // Legacy free-text listing location (kept for backward compatibility).
  if (location) where.location = { [Op.like]: `%${location}%` };
  // NOTE: providerType is applied on the PROVIDER join below, not on the
  // listing's own column, so a listing whose provider was since retired can
  // never leak through a stale denormalized value.
  if (availability === "in") where.stock = { [Op.gt]: 0 };
  else if (availability === "out") where.stock = { [Op.lte]: 0 };

  and.push(...providerLocationWhere({ city, state }));
  if (and.length) where[Op.and] = and;

  const offset = (page - 1) * limit;
  const { rows, count } = await MedicineStoreMedicine.findAndCountAll({
    where,
    // The pharmacy's cost, supplier, reorder level and batch data never leave
    // through a public endpoint.
    attributes: { exclude: PRIVATE_INVENTORY_ATTRS },
    include: [
      { model: MedicineCategory, as: "category", attributes: CATEGORY_ATTRS },
      { model: MedicineMaster, as: "master", attributes: ["id", "medicineName", "strength", "medicineType"] },
      // Only listings of ACTIVE providers, of an ACTIVE pharmacy type, are
      // sold. This single join clause is what removes retired MR listings from
      // patient search without deleting or rewriting one row of their data.
      {
        model: User,
        as: "provider",
        attributes: PUBLIC_PROVIDER_ATTRS,
        where: { isActive: true, role: { [Op.in]: rolesFor(providerType) } },
        required: true,
      },
    ],
    order: (BROWSE_SORTS[sort] || BROWSE_SORTS.relevance)(search),
    limit: Math.min(limit, 100),
    offset,
    distinct: true,
  });

  // Primary image per card from the global master's photos (one query for the
  // page); the provider's own legacy imageUrl stays the fallback.
  const images = await medicineMediaService.imagesByMaster(rows.map((r) => r.medicineMasterId));
  const medicines = rows.map((row) => ({
    ...row.toJSON(),
    ...publicPricing(row),
    primaryImageUrl: images.get(String(row.medicineMasterId))?.[0]?.imageUrl ?? row.imageUrl ?? null,
  }));

  return { medicines, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/** Listing rows scanned per autocomplete request (grouped into far fewer suggestions). */
const SUGGEST_SCAN_LIMIT = 200;

/**
 * Search-as-you-type: one suggestion per GLOBAL medicine (not one per pharmacy),
 * so "Zerodol" lists Zerodol-SP once even when five pharmacies sell it.
 *
 * Only listings that are for sale count (active listing, active pharmacy of an
 * active type — the same gate as browse). `fromPrice` is the cheapest price a
 * patient would actually pay among IN-STOCK listings and is null when nobody
 * has stock, so an unavailable medicine never shows a price it can't be bought
 * at. `listingId` is that cheapest in-stock listing (or, when none has stock,
 * any listing) so selecting a suggestion opens the existing detail page.
 * Nothing about the pharmacies beyond counts is returned.
 */
exports.suggestMedicines = async ({ q, limit = 8 } = {}) => {
  const tokenWhere = listingSearchWhere(q);
  if (!tokenWhere.length) return { suggestions: [] };

  const rows = await MedicineStoreMedicine.findAll({
    where: { isActive: true, [Op.and]: tokenWhere },
    attributes: [
      "id",
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
      "stock",
      "imageUrl",
    ],
    include: [
      {
        model: User,
        as: "provider",
        attributes: ["id"],
        where: { isActive: true, role: { [Op.in]: PROVIDER_ROLES } },
        required: true,
      },
    ],
    order: [...prefixFirst(q), IN_STOCK_FIRST, ["medicineName", "ASC"]],
    limit: SUGGEST_SCAN_LIMIT,
  });

  // Group per global medicine; rows arrive best-ranked first, so the Map keeps
  // that ranking for the groups.
  const groups = new Map();
  for (const row of rows) {
    const key = row.medicineMasterId ? `m${row.medicineMasterId}` : `l${row.id}`;
    const effective = effectiveUnitPrice(row);
    const inStock = Number(row.stock) > 0;
    let g = groups.get(key);
    if (!g) {
      g = { row, providerIds: new Set(), inStockCount: 0, best: null, fallbackImageUrl: null };
      groups.set(key, g);
    }
    g.providerIds.add(String(row.provider.id));
    if (inStock) g.inStockCount += 1;
    if (!g.fallbackImageUrl && row.imageUrl) g.fallbackImageUrl = row.imageUrl;
    const better =
      !g.best || (inStock && !g.best.inStock) || (inStock === g.best.inStock && effective < g.best.price);
    if (better) g.best = { id: row.id, price: effective, inStock, packSize: row.packSize };
  }

  const top = [...groups.values()].slice(0, Math.min(limit, 20));
  const images = await medicineMediaService.imagesByMaster(top.map((g) => g.row.medicineMasterId));

  return {
    suggestions: top.map((g) => ({
      masterId: g.row.medicineMasterId ? Number(g.row.medicineMasterId) : null,
      listingId: Number(g.best.id),
      medicineName: g.row.medicineName,
      genericName: g.row.genericName,
      medicineType: g.row.medicineType,
      strength: g.row.strength,
      manufacturer: g.row.manufacturer,
      packSize: g.best.packSize ?? g.row.packSize ?? null,
      imageUrl: images.get(String(g.row.medicineMasterId))?.[0]?.imageUrl ?? g.fallbackImageUrl ?? null,
      fromPrice: g.best.inStock ? g.best.price : null,
      available: g.inStockCount > 0,
      inStockCount: g.inStockCount,
      pharmacyCount: g.providerIds.size,
    })),
  };
};

exports.getMedicineDetails = async (id) => {
  const med = await MedicineStoreMedicine.findByPk(id, {
    attributes: { exclude: PRIVATE_INVENTORY_ATTRS },
    include: [
      { model: MedicineCategory, as: "category", attributes: CATEGORY_ATTRS },
      { model: MedicineMaster, as: "master", attributes: ["id", "medicineName", "strength", "medicineType"] },
      { model: User, as: "provider", attributes: [...PUBLIC_PROVIDER_ATTRS, "phone", "city", "state", "isActive"] },
    ],
  });
  if (!med || !med.isActive || !med.provider?.isActive) throw ApiError.notFound("Medicine not found");
  // A listing whose provider is no longer an active pharmacy type is not for
  // sale — the same rule browse applies, so a direct link cannot bypass it.
  if (!PROVIDER_ROLES.includes(med.provider.role)) throw ApiError.notFound("Medicine not found");

  // Gallery + substitutes both come from the global master (migration 037).
  const [images, substitutes] = await Promise.all([
    medicineMediaService.imagesByMaster([med.medicineMasterId]),
    medicineMediaService.substitutesForMaster(med.medicineMasterId),
  ]);
  const gallery = images.get(String(med.medicineMasterId)) || [];
  return {
    ...med.toJSON(),
    ...publicPricing(med),
    images: gallery.map(({ id, imageUrl, sortOrder }) => ({ id, imageUrl, sortOrder })),
    primaryImageUrl: gallery[0]?.imageUrl ?? med.imageUrl ?? null,
    substitutes,
  };
};

/**
 * A provider's public profile. Resolves LEGACY providers too — a patient
 * looking at an order they placed with an MR last month must still be able to
 * see who they bought from. Only the browse/search surfaces are narrowed.
 */
exports.getProviderProfile = async (providerId) => {
  const user = await User.findOne({
    where: { id: providerId, role: { [Op.in]: ALL_MEDICINE_PROVIDER_ROLES }, isActive: true },
    attributes: ["id", "name", "phone", "profilePhotoUrl", "addressLine", "city", "state", "pincode", "lat", "lng", "role"],
  });
  if (!user) throw ApiError.notFound("Provider not found");
  const medicineCount = await MedicineStoreMedicine.count({ where: { providerId, isActive: true } });
  return { ...user.toJSON(), medicineCount };
};

/**
 * Map an optional providerType filter to the user roles it covers, for the
 * patient-facing surfaces (browse, provider list, prescription sharing).
 *
 * A request for the retired "mr" type resolves to NO roles rather than to MR:
 * the filter is honoured literally — it simply matches nothing — instead of
 * silently widening to every pharmacy, which would show a patient results they
 * did not ask for.
 */
function rolesFor(providerType) {
  if (!providerType || providerType === "all") return PROVIDER_ROLES;
  return PROVIDER_ROLES.includes(providerType) ? [providerType] : [];
}
exports.rolesFor = rolesFor;

/**
 * Structured provider location match, shared by the provider list and the
 * share-prescription recipient check so both use ONE rule: case-insensitive
 * exact city AND state on the provider's registered Google location.
 */
function userLocationWhere({ city, state }) {
  const clauses = [];
  if (city) clauses.push(sqlWhere(fn("UPPER", col("city")), normalize(city)));
  if (state) clauses.push(sqlWhere(fn("UPPER", col("state")), normalize(state)));
  return clauses;
}
exports.userLocationWhere = userLocationWhere;

/**
 * Great-circle (haversine) distance in km from the bound `:originLat` /
 * `:originLng` to a provider's registered coordinates; NULL when the provider
 * has none. The origin travels as query replacements, never spliced into SQL.
 * LEAST(1, …) guards ASIN against float drift just above 1.
 */
const EARTH_RADIUS_KM = 6371;
const U = "`User`";
const DISTANCE_KM_SQL =
  `(${EARTH_RADIUS_KM} * 2 * ASIN(LEAST(1, SQRT(` +
  `POWER(SIN(RADIANS(${U}.\`lat\` - :originLat) / 2), 2) + ` +
  `COS(RADIANS(:originLat)) * COS(RADIANS(${U}.\`lat\`)) * POWER(SIN(RADIANS(${U}.\`lng\` - :originLng) / 2), 2)` +
  `))))`;
const roundKm = (km) => (km === null || km === undefined ? null : Math.round(Number(km) * 10) / 10);
const NO_COORDINATES_SQL = `(${U}.\`lat\` IS NULL OR ${U}.\`lng\` IS NULL)`;

/**
 * The registered pharmacies themselves — the data behind the public "Medicine
 * Stores" directory and its map pins, and behind the Share-Prescription
 * recipient list.
 *
 * Every row is a REAL registered provider read from `users`: its own name, its
 * own registered Google location (city/state/pincode/lat/lng) and a live count
 * of the medicines it currently lists. Nothing here is seeded, sampled or
 * hardcoded, and a pharmacy with no coordinates simply has no pin rather than
 * an invented one.
 *
 * @param {object} [params]
 * @param {boolean} [params.withCoordinates] only pharmacies that can be mapped
 * @param {number} [params.lat] patient position (with `lng`): adds `distanceKm`
 *   and orders nearest first, pharmacies without coordinates last
 * @param {number} [params.lng]
 * @param {number} [params.radiusKm] only pharmacies within this distance (needs lat/lng)
 */
exports.listProviders = async ({
  providerType,
  location,
  city,
  state,
  search,
  withCoordinates,
  lat,
  lng,
  radiusKm,
  page = 1,
  limit = 50,
} = {}) => {
  const near = lat !== undefined && lat !== null && lng !== undefined && lng !== null;
  const roles = rolesFor(providerType);
  if (!roles.length) return { providers: [], total: 0, page, limit, totalPages: 0 };

  const where = { isActive: true, role: { [Op.in]: roles } };
  if (search) where.name = { [Op.like]: `%${search}%` };
  if (withCoordinates) {
    where.lat = { [Op.ne]: null };
    where.lng = { [Op.ne]: null };
  }

  const clauses = userLocationWhere({ city, state });
  // Legacy free-text location param (kept for backward compatibility).
  if (location) {
    clauses.push({
      [Op.or]: [
        { addressLine: { [Op.like]: `%${location}%` } },
        { city: { [Op.like]: `%${location}%` } },
        { state: { [Op.like]: `%${location}%` } },
      ],
    });
  }
  // A provider without coordinates has a NULL distance, which never satisfies
  // `<= radius` — so the radius alone excludes them, and count() agrees.
  if (near && radiusKm) clauses.push(sqlWhere(literal(DISTANCE_KM_SQL), Op.lte, radiusKm));
  if (clauses.length) where[Op.and] = clauses;

  const attributes = [
    "id", "name", "role", "phone", "profilePhotoUrl",
    "addressLine", "city", "state", "pincode", "lat", "lng",
  ];
  const offset = (page - 1) * limit;
  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: near ? [...attributes, [literal(DISTANCE_KM_SQL), "distanceKm"]] : attributes,
    order: near
      ? [[literal(NO_COORDINATES_SQL), "ASC"], [literal(DISTANCE_KM_SQL), "ASC"], ["name", "ASC"], ["id", "ASC"]]
      : [["name", "ASC"]],
    ...(near ? { replacements: { originLat: lat, originLng: lng } } : {}),
    limit: Math.min(limit, 100),
    offset,
  });

  // How many medicines each of THESE pharmacies lists — one grouped query for
  // the whole page, never a count per row.
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await MedicineStoreMedicine.findAll({
        attributes: ["providerId", [fn("COUNT", col("id")), "n"]],
        where: { providerId: { [Op.in]: ids }, isActive: true },
        group: ["providerId"],
        raw: true,
      })
    : [];
  const countByProvider = new Map(counts.map((c) => [String(c.providerId), Number(c.n)]));

  const providers = rows.map((row) => ({
    ...row.toJSON(),
    ...(near ? { distanceKm: roundKm(row.get("distanceKm")) } : {}),
    /** The provider's type, named the way the product names it. */
    providerType: row.role,
    typeLabel: MEDICINE_PROVIDER_TYPE_LABELS[row.role] || "Pharmacy",
    medicineCount: countByProvider.get(String(row.id)) || 0,
  }));

  return { providers, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

// ── Global categories ─────────────────────────────────────────────────────

/** Every category is global; `search` is a case-insensitive substring match. */
exports.listCategories = async ({ search } = {}) => {
  const where = {};
  if (search) where.name = { [Op.like]: `%${cleanDisplay(search)}%` };
  return MedicineCategory.findAll({ where, attributes: CATEGORY_ATTRS, order: [["name", "ASC"]] });
};

const toSlug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Find-or-create a GLOBAL category. The name is compared case-insensitively
 * (and whitespace-normalized); if an equivalent exists it is returned as-is
 * (`created: false`) — no duplicate row, no error. Only a genuinely new name
 * creates a row. The creator is recorded for audit only.
 */
exports.createCategory = async (userId, role, { name, slug }) => {
  const displayName = cleanDisplay(name);
  const safeSlug = toSlug(cleanDisplay(slug) || displayName);
  if (!safeSlug) throw ApiError.badRequest("Category name must contain letters or numbers");

  const findEquivalent = () =>
    MedicineCategory.findOne({
      where: { [Op.or]: [ciEquals("name", displayName), { slug: safeSlug }] },
      attributes: CATEGORY_ATTRS,
    });

  const existing = await findEquivalent();
  if (existing) return { category: existing, created: false };

  // A legacy MR may still curate its own inventory, so it may still author a
  // category — only the patient-facing surfaces were narrowed.
  const isProvider = ALL_MEDICINE_PROVIDER_ROLES.includes(role);
  try {
    const category = await MedicineCategory.create({
      name: displayName,
      slug: safeSlug,
      providerId: isProvider ? userId : null,
      providerType: isProvider ? role : null,
    });
    return { category: pick(category.toJSON(), CATEGORY_ATTRS), created: true };
  } catch (err) {
    // Concurrent create of the same name — the unique index caught it; reuse it.
    if (err instanceof UniqueConstraintError) {
      const raced = await findEquivalent();
      if (raced) return { category: raced, created: false };
    }
    throw err;
  }
};

/** Admin-only (routes): categories are shared, so providers can never delete them. */
exports.deleteCategory = async (categoryId) => {
  const category = await MedicineCategory.findByPk(categoryId);
  if (!category) throw ApiError.notFound("Category not found");
  const [medicineCount, masterCount] = await Promise.all([
    MedicineStoreMedicine.count({ where: { categoryId } }),
    MedicineMaster.count({ where: { categoryId } }),
  ]);
  if (medicineCount > 0 || masterCount > 0) {
    throw ApiError.badRequest("Cannot delete category that has medicines assigned");
  }
  await category.destroy();
  return { id: String(categoryId) };
};
