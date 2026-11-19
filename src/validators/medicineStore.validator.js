const Joi = require("joi");
const { ACTIVE_MEDICINE_PROVIDER_ROLES, MEDICINE_PROVIDER_TYPE } = require("../config/constants");
const { INVENTORY_FIELDS, QUANTITY, DAY, BATCH_NUMBER } = require("./pharmacy.validator");

/**
 * Provider-type filters a patient may send. The retired "mr" value is still
 * ACCEPTED (an old bookmark or a saved filter must not 422) — the service
 * resolves it to no providers, so the answer is an honest empty list rather
 * than an error or, worse, every pharmacy.
 */
const PROVIDER_TYPE_FILTER = Joi.string()
  .valid(...ACTIVE_MEDICINE_PROVIDER_ROLES, MEDICINE_PROVIDER_TYPE.MR, "all")
  .allow("", null);

const SAFE = (max) => Joi.string().trim().max(max);
const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);

// ── Medicine CRUD (provider) ─────────────────────────────────────────────

/**
 * Add a medicine to the provider's own inventory. Either pick an existing
 * global master (`medicineMasterId`) — then only the provider fields matter —
 * or describe a new medicine (name + type required); the service reuses an
 * existing master with the same case-insensitive identity instead of
 * duplicating it. IDs are numbers end-to-end (INT/BIGINT columns → JSON numbers).
 */
const createMedicine = Joi.object({
  medicineMasterId: Joi.number().integer().positive(),
  categoryId: Joi.number().integer().positive().allow(null),
  medicineName: SAFE(255).when("medicineMasterId", { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  genericName: SAFE(255).allow("", null),
  medicineType: SAFE(50).when("medicineMasterId", { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  strength: SAFE(100).allow("", null),
  manufacturer: SAFE(255).allow("", null),
  description: Joi.string().trim().max(5000).allow("", null),
  // The pharmacy's own commercial data (migration 043). Only the selling price
  // is required; an image never is — photos are added later, if at all.
  ...INVENTORY_FIELDS,
  price: INVENTORY_FIELDS.price.required(),
  /** Opening stock; lands in `batchNumber` when one is given, else untracked. */
  stock: QUANTITY.default(0),
  batchNumber: BATCH_NUMBER.allow("", null),
  expiryDate: DAY.allow("", null),
  location: SAFE(255).allow("", null),
  imageUrl: SAFE(512).allow("", null),
});

/**
 * A provider edits only THEIR inventory fields. Global medicine fields belong
 * to the shared master and are stripped (stripUnknown) if sent.
 */
const updateMedicine = Joi.object({
  ...INVENTORY_FIELDS,
  /** The new TOTAL stock — a manual correction applied to the untracked units. */
  stock: QUANTITY,
  stockNote: SAFE(255).allow("", null),
  location: SAFE(255).allow("", null),
  imageUrl: SAFE(512).allow("", null),
  isActive: Joi.boolean(),
}).min(1);

/** "Search Existing Medicine" on the provider Add Medicine page. */
const searchMasters = Joi.object({
  search: SAFE(100).allow("", null),
  categoryId: Joi.number().integer().positive(),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

const listMyMedicines = Joi.object({
  search: SAFE(100).allow("", null),
  category: ID.allow(null),
  form: SAFE(50).allow("", null),
  stockStatus: Joi.string().valid("in", "low", "out").allow("", null),
  /** Expiry of the nearest-expiring batch that still has stock. */
  expiry: Joi.string().valid("expired", "expiring", "valid", "none").allow("", null),
  supplierId: Joi.number().integer().positive(),
  active: Joi.string().valid("active", "inactive", "all").default("active"),
  sort: Joi.string().valid("name", "stock", "price", "expiry", "updated").default("name"),
  order: Joi.string().valid("asc", "desc").default("asc"),
  page: PAGE,
  limit: LIMIT,
});

// ── Patient marketplace ──────────────────────────────────────────────────

// `city` + `state` are the patient's Google selection, matched against the
// provider's registered structured location; `location` is the legacy free text.
const browseMedicines = Joi.object({
  search: SAFE(100).allow("", null),
  category: ID.allow(null),
  location: SAFE(100).allow("", null),
  city: SAFE(100).allow("", null),
  state: SAFE(100).allow("", null),
  providerType: PROVIDER_TYPE_FILTER,
  availability: Joi.string().valid("in", "out").allow("", null),
  /** Range on the price the patient pays (after the pharmacy's item discount). */
  minPrice: Joi.number().min(0).max(1_000_000),
  maxPrice: Joi.number().min(0).max(1_000_000),
  /** One store's listings only (the mobile store page). */
  providerId: Joi.number().integer().positive(),
  /** Minimum item discount %, the same figure the response's `discountPercent` shows. */
  minDiscount: Joi.number().min(0).max(100),
  sort: Joi.string().valid("relevance", "price_asc", "price_desc", "discount", "name").default("relevance"),
  page: PAGE,
  limit: LIMIT,
});

/** Search-as-you-type on the patient medicine page. */
const suggestMedicines = Joi.object({
  q: SAFE(100).allow("").default(""),
  limit: Joi.number().integer().min(1).max(20).default(8),
});

// The registered-pharmacy list: the share-prescription recipient picker AND
// the public "Medicine Stores" directory / map. Location arrives as the
// structured Google selection (city + state), plus an optional name search.
const listProviders = Joi.object({
  providerType: PROVIDER_TYPE_FILTER,
  location: SAFE(150).allow("", null),
  city: SAFE(100).allow("", null),
  state: SAFE(100).allow("", null),
  search: SAFE(100).allow("", null),
  /** Map view: only pharmacies whose registered location has coordinates. */
  withCoordinates: Joi.boolean().default(false),
  /** "Near me": the patient's position. Both or neither; enables `distanceKm` + nearest-first order. */
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
  /** Only pharmacies within this many km of lat/lng (requires both). */
  radiusKm: Joi.number().min(1).max(200),
  page: PAGE,
  limit: LIMIT,
})
  .and("lat", "lng")
  .with("radiusKm", ["lat", "lng"]);

// ── Categories (global) ──────────────────────────────────────────────────

const listCategories = Joi.object({
  search: SAFE(100).allow("", null),
});

const createCategory = Joi.object({
  name: SAFE(150).required(),
  slug: SAFE(150).allow("", null),
});

// ── Medicine images + substitutes (global master, migration 037) ─────────

const MASTER_ID = Joi.number().integer().positive();

/** New display order: every current image id of the medicine, primary first. */
const reorderImages = Joi.object({
  imageIds: Joi.array().items(MASTER_ID).min(1).unique().required(),
});

/** Replace-the-set: existing master ids only (an empty list clears it). */
const setSubstitutes = Joi.object({
  substituteIds: Joi.array().items(MASTER_ID).unique().required(),
});

module.exports = {
  reorderImages,
  setSubstitutes,
  createMedicine,
  updateMedicine,
  listMyMedicines,
  searchMasters,
  browseMedicines,
  suggestMedicines,
  listProviders,
  listCategories,
  createCategory,
};
