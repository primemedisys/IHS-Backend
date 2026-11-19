/**
 * Joi validators for medicine orders, checkout and the (simulated) payment.
 *
 * What a client is allowed to send is deliberately narrow: ids, quantities, a
 * payment METHOD and a delivery location. Price, stock, line totals, the order
 * total and the payment STATUS are decided by the service and are not in any
 * schema here — sending them is not "rejected", it is impossible.
 */
const Joi = require("joi");
const {
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_TRANSITIONS,
  MEDICINE_PAYMENT_METHOD,
} = require("../config/constants");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);
const QUANTITY = Joi.number().integer().min(1).max(9999);

/** Every status a client may FILTER by (the full lifecycle, including closed). */
const ORDER_STATUSES = Object.values(MEDICINE_ORDER_STATUS);

/**
 * Statuses a pharmacy may SET, derived from the one transition table — so the
 * schema can never allow a step the service would then reject, or block one it
 * would accept.
 */
const SETTABLE_STATUSES = [...new Set(Object.values(MEDICINE_ORDER_TRANSITIONS).flat())];

/**
 * The delivery location, in the same structured shape as a provider's
 * registered Google location. A free-text address is required (it is what the
 * rider reads); the structured parts come from the Google picker when the
 * patient used it.
 */
const DELIVERY = {
  deliveryAddress: Joi.string().trim().min(5).max(500).required(),
  deliveryCity: Joi.string().trim().max(100).allow("", null),
  deliveryState: Joi.string().trim().max(100).allow("", null),
  deliveryPincode: Joi.string().trim().max(20).allow("", null),
  deliveryLat: Joi.number().min(-90).max(90).allow(null),
  deliveryLng: Joi.number().min(-180).max(180).allow(null),
  notes: Joi.string().trim().max(500).allow("", null),
};

const PAYMENT_METHOD = Joi.string()
  .valid(...Object.values(MEDICINE_PAYMENT_METHOD))
  .required();

/** Order one medicine straight from its detail page. */
const placeOrder = Joi.object({
  medicineId: ID.required(),
  quantity: QUANTITY.default(1),
  paymentMethod: PAYMENT_METHOD,
  ...DELIVERY,
});

/** Check out the cart, or just the selected lines of it. */
const checkout = Joi.object({
  /** Omitted = the whole cart. */
  itemIds: Joi.array().items(ID).min(1).max(100),
  paymentMethod: PAYMENT_METHOD,
  ...DELIVERY,
});

/**
 * Settle an online order's SIMULATED payment.
 *
 * `outcome` exists so the failure path is testable end to end without a
 * gateway; it is accepted only because no real money is involved. When a real
 * gateway is integrated this schema is replaced by the gateway's signed
 * callback payload and the outcome stops being client-supplied.
 */
const payOrder = Joi.object({
  outcome: Joi.string().valid("success", "failure").default("success"),
  /** Makes a retried/double-submitted payment a no-op instead of a second charge. */
  idempotencyKey: Joi.string().trim().max(100).allow("", null),
});

const listOrders = Joi.object({
  status: Joi.string().valid(...ORDER_STATUSES),
  page: PAGE,
  limit: LIMIT,
});

const updateStatus = Joi.object({
  status: Joi.string()
    .valid(...SETTABLE_STATUSES)
    .required(),
});

module.exports = {
  placeOrder,
  checkout,
  payOrder,
  listOrders,
  updateStatus,
};
