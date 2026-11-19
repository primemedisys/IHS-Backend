/**
 * Query schemas for the admin pharmacy / medicine tracking reads. All GETs, so
 * they run through `middlewares/validateQuery` (req.validatedQuery).
 */
const Joi = require("joi");
const {
  ALL_MEDICINE_PROVIDER_ROLES,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_PAYMENT_METHOD,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
} = require("../config/constants");

const from = Joi.date().iso().optional();
const to = Joi.date().iso().optional().greater(Joi.ref("from"));
const id = Joi.number().integer().positive().optional();
const providerType = Joi.string().valid(...ALL_MEDICINE_PROVIDER_ROLES).optional();
const page = Joi.number().integer().min(1).default(1);
const limit = Joi.number().integer().min(1).max(LEDGER_PAGE_SIZE_MAX).default(LEDGER_PAGE_SIZE_DEFAULT);
const search = Joi.string().trim().max(100).allow("").optional();

/** Order filters, shared by the overview's order aggregates and the tracking list. */
const orderFilters = {
  from,
  to,
  pharmacyId: id,
  providerType,
  medicine: search,
  orderStatus: Joi.string().valid(...Object.values(MEDICINE_ORDER_STATUS)).optional(),
  paymentStatus: Joi.string().valid(...Object.values(MEDICINE_ORDER_PAYMENT_STATUS)).optional(),
  paymentMethod: Joi.string().valid(...Object.values(MEDICINE_PAYMENT_METHOD)).optional(),
};

const overview = Joi.object(orderFilters);
const orders = Joi.object({ ...orderFilters, page, limit });

const inventory = Joi.object({
  search,
  providerId: id,
  providerType,
  stock: Joi.string().valid("in", "out", "low").optional(),
  page,
  limit,
});

const pharmacies = Joi.object({ providerType, search });

module.exports = { overview, orders, inventory, pharmacies };
