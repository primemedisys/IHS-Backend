/**
 * A pharmacy's own suppliers (migration 043). Every query is scoped by the
 * signed-in provider's id — one pharmacy can never read or change another's
 * suppliers. A name is unique per pharmacy (case-insensitive), so "ABC
 * Pharma" and "abc pharma" are one supplier; a supplier that has purchases is
 * deactivated rather than deleted, keeping purchase history intact.
 */
const { Op, UniqueConstraintError, fn, col } = require("sequelize");
const { PharmacySupplier, PharmacyPurchase } = require("../models");
const ApiError = require("../utils/ApiError");
const { cleanDisplay } = require("../utils/medicineIdentity");
const { PURCHASE_STATUS } = require("../config/pharmacy");

const blankToNull = (v) => (v === "" || v === undefined ? null : v);

function clean(dto) {
  const out = {};
  if (dto.name !== undefined) out.name = cleanDisplay(dto.name);
  for (const key of ["contactPerson", "phone", "email", "address", "gstin"]) {
    if (dto[key] !== undefined) out[key] = blankToNull(dto[key]);
  }
  if (dto.isActive !== undefined) out.isActive = dto.isActive;
  return out;
}

const conflict = (name) => ApiError.conflict(`You already have a supplier named "${name}"`);

exports.list = async (providerId, { search, active = "active", page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (active === "active") where.isActive = true;
  else if (active === "inactive") where.isActive = false;
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [{ name: like }, { contactPerson: like }, { phone: like }, { gstin: like }];
  }

  const { rows, count } = await PharmacySupplier.findAndCountAll({
    where,
    order: [["name", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });

  // Purchase count + value per supplier on this page, in ONE grouped query.
  const ids = rows.map((r) => r.id);
  const totals = ids.length
    ? await PharmacyPurchase.findAll({
        where: { providerId, supplierId: { [Op.in]: ids }, status: PURCHASE_STATUS.RECEIVED },
        attributes: ["supplierId", [fn("COUNT", col("id")), "purchases"], [fn("SUM", col("total_amount")), "value"], [fn("MAX", col("invoice_date")), "lastPurchase"]],
        group: ["supplierId"],
        raw: true,
      })
    : [];
  const byId = new Map(totals.map((t) => [String(t.supplierId), t]));

  return {
    suppliers: rows.map((r) => {
      const t = byId.get(String(r.id));
      return {
        ...r.toJSON(),
        purchaseCount: Number(t?.purchases || 0),
        purchaseValue: Number(Number(t?.value || 0).toFixed(2)),
        lastPurchaseDate: t?.lastPurchase || null,
      };
    }),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

async function findOwned(providerId, id, transaction) {
  const supplier = await PharmacySupplier.findOne({ where: { id, providerId }, transaction });
  if (!supplier) throw ApiError.notFound("Supplier not found");
  return supplier;
}

exports.get = async (providerId, id) => findOwned(providerId, id);

exports.create = async (providerId, dto) => {
  const data = clean(dto);
  try {
    return await PharmacySupplier.create({ ...data, providerId });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw conflict(data.name);
    throw err;
  }
};

exports.update = async (providerId, id, dto) => {
  const supplier = await findOwned(providerId, id);
  const data = clean(dto);
  try {
    await supplier.update(data);
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw conflict(data.name);
    throw err;
  }
  return supplier;
};

/**
 * Find-or-create suppliers by name for ONE pharmacy, in two queries
 * regardless of how many names (the Excel import path). Returns
 * Map(UPPER(name) → supplier) and the names that were created.
 */
exports.findOrCreateByNames = async (providerId, names, transaction) => {
  const wanted = new Map();
  for (const n of names) {
    const display = cleanDisplay(n);
    if (display) wanted.set(display.toUpperCase(), display);
  }
  if (!wanted.size) return { byName: new Map(), created: [] };

  const load = () =>
    PharmacySupplier.findAll({
      where: { providerId, name: { [Op.in]: [...wanted.values()] } },
      transaction,
    });
  let rows = await load();
  const have = new Set(rows.map((r) => r.name.toUpperCase()));
  const missing = [...wanted.entries()].filter(([key]) => !have.has(key)).map(([, display]) => display);
  if (missing.length) {
    await PharmacySupplier.bulkCreate(
      missing.map((name) => ({ providerId, name })),
      { transaction, ignoreDuplicates: true }
    );
    rows = await load();
  }
  return { byName: new Map(rows.map((r) => [r.name.toUpperCase(), r])), created: missing };
};

exports.findOwned = findOwned;
