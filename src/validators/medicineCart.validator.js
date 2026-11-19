/**
 * Joi validators for the medicine cart. Validation lives ONLY here —
 * controllers trust `req.body` after `validate()` and services never
 * re-validate shape (they re-validate BUSINESS state: price, stock, ownership).
 */
const Joi = require("joi");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const QUANTITY = Joi.number().integer().min(1).max(9999);

/** Add a provider's inventory row to the cart (or raise its quantity). */
const addItem = Joi.object({
  medicineId: ID.required(),
  quantity: QUANTITY.default(1),
  /** Set when the line came off a pharmacy's prescription availability answer. */
  prescriptionRequestId: ID.allow(null),
});

/** Set an exact quantity on a cart line; 0 removes it. */
const updateItem = Joi.object({
  quantity: Joi.number().integer().min(0).max(9999).required(),
});

/** Move a pharmacy's available prescription medicines into the cart. */
const addFromPrescription = Joi.object({
  items: Joi.array()
    .items(Joi.object({ itemId: ID.required(), quantity: QUANTITY.required() }))
    .min(1)
    .max(100)
    .required(),
});

module.exports = {
  addItem,
  updateItem,
  addFromPrescription,
};
