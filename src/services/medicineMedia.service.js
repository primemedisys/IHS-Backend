/**
 * Medicine images + substitute medicines (migration 037).
 *
 * Both belong to the GLOBAL medicine master, so one set of photos / one
 * substitute list serves every pharmacy selling that medicine.
 *
 * Who may curate a master: an admin, or a pharmacy that currently sells it
 * (has an active inventory row for it). Deleting an image is limited further
 * to the admin or the uploader, so one pharmacy can never remove another's
 * photo.
 *
 * Images are stored through the existing upload.service (local disk / S3 —
 * the same driver every document upload uses); no new storage is introduced.
 *
 * Substitutes are references to existing masters. Their price and
 * availability are always derived from real provider inventory rows (active
 * listings of active, active-type pharmacies), never stored or assumed.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  MedicineMaster,
  MedicineMasterImage,
  MedicineMasterSubstitute,
  MedicineStoreMedicine,
  User,
} = require("../models");
const { effectiveUnitPrice } = require("../utils/medicinePricing");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const uploadService = require("./upload.service");
const {
  ROLES,
  ERROR_CODES,
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  MAX_MEDICINE_IMAGES,
  MAX_MEDICINE_SUBSTITUTES,
} = require("../config/constants");

const IMAGE_ATTRS = ["id", "imageUrl", "sortOrder", "uploadedBy"];
const SUBSTITUTE_MASTER_ATTRS = ["id", "medicineName", "genericName", "medicineType", "strength", "manufacturer"];
const IMAGE_ORDER = [
  ["sortOrder", "ASC"],
  ["id", "ASC"],
];

const isAdmin = (user) => user.role === ROLES.ADMIN;

async function findMaster(masterId, transaction) {
  const master = await MedicineMaster.findOne({ where: { id: masterId, isActive: true }, transaction });
  if (!master) throw ApiError.notFound("Medicine not found in the catalogue");
  return master;
}

/** Admin, or a pharmacy with an active inventory row for this master. */
async function assertCanCurate(user, masterId) {
  if (isAdmin(user)) return;
  const sells = await MedicineStoreMedicine.count({
    where: { providerId: user.id, medicineMasterId: masterId, isActive: true },
  });
  if (!sells) {
    throw ApiError.forbidden("Only a pharmacy selling this medicine (or an admin) can change its images or substitutes", {
      code: ERROR_CODES.FORBIDDEN,
    });
  }
}

// ── Shared readers (one query per call, never per row) ─────────────────────

/** Map<masterId, image[]> for many masters in ONE query, primary first. */
async function imagesByMaster(masterIds) {
  const ids = [...new Set(masterIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await MedicineMasterImage.findAll({
    where: { medicineMasterId: { [Op.in]: ids } },
    attributes: [...IMAGE_ATTRS, "medicineMasterId"],
    order: IMAGE_ORDER,
  });
  const map = new Map();
  for (const row of rows) {
    const key = String(row.medicineMasterId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: row.id, imageUrl: row.imageUrl, sortOrder: row.sortOrder, uploadedBy: row.uploadedBy });
  }
  return map;
}
exports.imagesByMaster = imagesByMaster;

/**
 * Real market summary of each substitute master: the cheapest listing among
 * ACTIVE listings of ACTIVE pharmacies of an active type, preferring listings
 * that have stock. `available` is true only when some listing has stock > 0.
 * `listingId` is that best inventory row, so the patient opens the EXISTING
 * medicine detail page for it; it is null when nobody sells the medicine.
 */
async function marketSummaryByMaster(masterIds) {
  if (!masterIds.length) return new Map();
  const listings = await MedicineStoreMedicine.findAll({
    where: { medicineMasterId: { [Op.in]: masterIds }, isActive: true },
    attributes: ["id", "medicineMasterId", "price", "discountPercent", "stock", "imageUrl"],
    include: [
      {
        model: User,
        as: "provider",
        attributes: ["id"],
        where: { isActive: true, role: { [Op.in]: ACTIVE_MEDICINE_PROVIDER_ROLES } },
        required: true,
      },
    ],
  });

  const map = new Map();
  for (const l of listings) {
    const key = String(l.medicineMasterId);
    // What the patient would actually pay there (after the pharmacy's item discount).
    const price = effectiveUnitPrice(l);
    const inStock = Number(l.stock) > 0;
    const cur = map.get(key) || { providerCount: 0, inStockCount: 0, best: null, fallbackImageUrl: null };
    cur.providerCount += 1;
    if (inStock) cur.inStockCount += 1;
    if (!cur.fallbackImageUrl && l.imageUrl) cur.fallbackImageUrl = l.imageUrl;
    const better =
      !cur.best ||
      (inStock && !cur.best.inStock) ||
      (inStock === cur.best.inStock && price < cur.best.price);
    if (better) cur.best = { id: l.id, price, inStock };
    map.set(key, cur);
  }
  return map;
}

/**
 * Substitutes of one master for the public detail page: name, primary image,
 * real price ("from", cheapest listing) and real availability.
 */
exports.substitutesForMaster = async (masterId) => {
  if (!masterId) return [];
  const links = await MedicineMasterSubstitute.findAll({
    where: { medicineMasterId: masterId },
    include: [{ model: MedicineMaster, as: "substitute", attributes: SUBSTITUTE_MASTER_ATTRS, where: { isActive: true }, required: true }],
    order: [["id", "ASC"]],
  });
  const subIds = links.map((l) => l.substituteMasterId);
  const [images, market] = await Promise.all([imagesByMaster(subIds), marketSummaryByMaster(subIds)]);

  return links.map(({ substitute }) => {
    const key = String(substitute.id);
    const m = market.get(key);
    return {
      ...substitute.toJSON(),
      primaryImageUrl: images.get(key)?.[0]?.imageUrl ?? m?.fallbackImageUrl ?? null,
      price: m?.best ? m.best.price : null,
      providerCount: m?.providerCount ?? 0,
      inStockCount: m?.inStockCount ?? 0,
      available: Boolean(m?.inStockCount),
      listingId: m?.best?.id ?? null,
    };
  });
};

/** Substitute masters (id + name) for the curation form — no market data needed. */
async function substituteMastersOf(masterId) {
  const links = await MedicineMasterSubstitute.findAll({
    where: { medicineMasterId: masterId },
    include: [{ model: MedicineMaster, as: "substitute", attributes: SUBSTITUTE_MASTER_ATTRS, required: true }],
    order: [["id", "ASC"]],
  });
  return links.map((l) => l.substitute.toJSON());
}

// ── Curation (pharmacy / admin) ────────────────────────────────────────────

/** Images + substitutes of a master, plus what the caller may change. */
exports.getMasterMedia = async (user, masterId) => {
  const master = await findMaster(masterId);
  const [images, substitutes, sells] = await Promise.all([
    imagesByMaster([master.id]).then((m) => m.get(String(master.id)) || []),
    substituteMastersOf(master.id),
    isAdmin(user)
      ? Promise.resolve(1)
      : MedicineStoreMedicine.count({ where: { providerId: user.id, medicineMasterId: master.id, isActive: true } }),
  ]);
  return {
    masterId: master.id,
    images: images.map((img) => ({ ...img, canDelete: isAdmin(user) || sameId(img.uploadedBy, user.id) })),
    substitutes,
    maxImages: MAX_MEDICINE_IMAGES,
    maxSubstitutes: MAX_MEDICINE_SUBSTITUTES,
    canEdit: Boolean(sells),
  };
};

/**
 * Upload one image to a master. The bytes are stored first (outside the
 * transaction, so a slow upload never holds a row lock); the count check and
 * insert then run under a lock on the master row, and the stored object is
 * removed again if the limit was reached meanwhile.
 */
exports.addImage = async (user, masterId, file) => {
  // The shared upload middleware also admits documents; this slot is an <img>.
  if (!file.mimetype?.startsWith("image/")) {
    throw new ApiError(422, "Unsupported file type — upload a PNG, JPEG or WebP image", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  await findMaster(masterId);
  await assertCanCurate(user, masterId);

  const stored = await uploadService.put(file.buffer, {
    keyPrefix: `medicine/masters/${masterId}/images`,
    filename: file.originalname,
    mimetype: file.mimetype,
  });

  try {
    await sequelize.transaction(async (transaction) => {
      await MedicineMaster.findByPk(masterId, { attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE });
      const existing = await MedicineMasterImage.findAll({
        where: { medicineMasterId: masterId },
        attributes: ["sortOrder"],
        transaction,
      });
      if (existing.length >= MAX_MEDICINE_IMAGES) {
        throw new ApiError(422, `A medicine can have at most ${MAX_MEDICINE_IMAGES} images`, {
          code: ERROR_CODES.VALIDATION_ERROR,
        });
      }
      const nextOrder = existing.reduce((max, r) => Math.max(max, r.sortOrder + 1), 0);
      await MedicineMasterImage.create(
        {
          medicineMasterId: masterId,
          imageUrl: stored.url,
          storageKey: stored.key,
          sortOrder: nextOrder,
          uploadedBy: user.id,
        },
        { transaction }
      );
    });
  } catch (err) {
    await uploadService.remove(stored.key).catch(() => {});
    throw err;
  }
  return exports.getMasterMedia(user, masterId);
};

/** Remove one image: the admin or whoever uploaded it. */
exports.removeImage = async (user, masterId, imageId) => {
  const image = await MedicineMasterImage.findOne({ where: { id: imageId, medicineMasterId: masterId } });
  if (!image) throw ApiError.notFound("Image not found");
  if (!isAdmin(user) && !sameId(image.uploadedBy, user.id)) {
    throw ApiError.forbidden("Only the pharmacy that uploaded this image (or an admin) can remove it", {
      code: ERROR_CODES.FORBIDDEN,
    });
  }
  await image.destroy();
  await uploadService.remove(image.storageKey || uploadService.keyFromUrl(image.imageUrl));
  return exports.getMasterMedia(user, masterId);
};

/** Reorder a master's images; `imageIds` must be exactly its current images. */
exports.reorderImages = async (user, masterId, imageIds) => {
  await findMaster(masterId);
  await assertCanCurate(user, masterId);
  const rows = await MedicineMasterImage.findAll({ where: { medicineMasterId: masterId } });
  const wanted = imageIds.map(String);
  const current = new Set(rows.map((r) => String(r.id)));
  if (wanted.length !== current.size || !wanted.every((id) => current.has(id))) {
    throw ApiError.badRequest("imageIds must list every image of this medicine exactly once");
  }
  const byId = new Map(rows.map((r) => [String(r.id), r.toJSON()]));
  // One statement (INSERT … ON DUPLICATE KEY UPDATE) for the whole new order.
  await MedicineMasterImage.bulkCreate(
    wanted.map((id, index) => ({ ...byId.get(id), sortOrder: index })),
    { updateOnDuplicate: ["sortOrder", "updatedAt"] }
  );
  return exports.getMasterMedia(user, masterId);
};

/**
 * Replace a master's substitute set with existing, active masters. Never
 * creates a medicine: every id must already be in the catalogue.
 */
exports.setSubstitutes = async (user, masterId, substituteIds) => {
  await findMaster(masterId);
  await assertCanCurate(user, masterId);

  const ids = [...new Set(substituteIds.map(String))];
  if (ids.includes(String(masterId))) throw ApiError.badRequest("A medicine cannot be its own substitute");
  if (ids.length > MAX_MEDICINE_SUBSTITUTES) {
    throw ApiError.badRequest(`A medicine can list at most ${MAX_MEDICINE_SUBSTITUTES} substitutes`);
  }
  if (ids.length) {
    const found = await MedicineMaster.count({ where: { id: { [Op.in]: ids }, isActive: true } });
    if (found !== ids.length) throw ApiError.badRequest("One or more substitute medicines do not exist");
  }

  await sequelize.transaction(async (transaction) => {
    await MedicineMasterSubstitute.destroy({ where: { medicineMasterId: masterId }, transaction });
    if (ids.length) {
      await MedicineMasterSubstitute.bulkCreate(
        ids.map((substituteMasterId) => ({ medicineMasterId: masterId, substituteMasterId, createdBy: user.id })),
        { transaction }
      );
    }
  });
  return exports.getMasterMedia(user, masterId);
};
