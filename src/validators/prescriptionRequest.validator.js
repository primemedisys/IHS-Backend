/**
 * Joi validators for the prescription availability flow. Validation lives ONLY
 * here — controllers trust `req.body` after `validate()` and services never
 * re-validate (backend-plan.md §5).
 */
const Joi = require("joi");
const {
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  MEDICINE_PROVIDER_TYPE,
  MEDICINE_PAYMENT_METHOD,
} = require("../config/constants");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);

const REQUEST_STATUSES = ["pending", "viewed", "processing", "completed", "rejected"];

const uploadAndShare = Joi.object({
  // multipart sends one `providerIds` field per provider, so busboy yields a
  // plain string when exactly one is selected; `.single()` maps that to [id].
  providerIds: Joi.array().items(ID).min(1).max(20).single().required(),
  // "all" (or omitted) = every ACTIVE pharmacy type (Pharmacy Medicine Store /
  // Clinic + Pharmacy Hospital). The retired "mr" value is still accepted so a
  // stale client does not 422; it simply matches no providers. Each request's
  // provider_type is taken from the provider's actual role server-side.
  providerType: Joi.string()
    .valid(...ACTIVE_MEDICINE_PROVIDER_ROLES, MEDICINE_PROVIDER_TYPE.MR, "all")
    .allow("", null),
  notes: Joi.string().trim().max(1000).allow("", null),
  // The patient's Google location selection. When sent, every selected
  // provider must be registered in it (re-checked server-side).
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
});

const listRequests = Joi.object({
  status: Joi.string().valid(...REQUEST_STATUSES),
  // Request-date range on created_at: `from` inclusive, `to` exclusive. The
  // client sends its own local-day boundaries as ISO instants, so "23 Sep"
  // means the patient's/pharmacy's day, not the server's UTC day.
  from: Joi.date().iso(),
  to: Joi.date().iso().when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")) }),
  page: PAGE,
  limit: LIMIT,
});

const updateStatus = Joi.object({
  status: Joi.string().valid("viewed", "processing", "completed", "rejected").required(),
});

/** A provider's answer for one medicine on the prescription. */
const itemAnswer = Joi.alternatives().try(
  Joi.object({
    status: Joi.string().valid("available").required(),
    medicineId: ID.required(),
    medicineName: Joi.string().trim().max(255).allow("", null),
    quantity: Joi.number().integer().min(1).max(9999),
  }),
  Joi.object({
    status: Joi.string().valid("unavailable").required(),
    medicineName: Joi.string().trim().min(1).max(255).required(),
    reason: Joi.string().trim().max(500).allow("", null),
  })
);

const submitAvailability = Joi.object({
  items: Joi.array().items(itemAnswer).min(1).max(100).required(),
});

/** The medicines (and quantities) a patient picked off the pharmacy's answer. */
const selection = Joi.array()
  .items(
    Joi.object({
      itemId: ID.required(),
      quantity: Joi.number().integer().min(1).max(9999).required(),
    })
  )
  .min(1)
  .max(100)
  .required();

/**
 * Order the selected medicines now. Same delivery + payment contract as a cart
 * checkout, because it runs through the same order-creation path.
 */
const placeOrderFromPrescription = Joi.object({
  items: selection,
  paymentMethod: Joi.string()
    .valid(...Object.values(MEDICINE_PAYMENT_METHOD))
    .required(),
  deliveryAddress: Joi.string().trim().min(5).max(500).required(),
  deliveryCity: Joi.string().trim().max(100).allow("", null),
  deliveryState: Joi.string().trim().max(100).allow("", null),
  deliveryPincode: Joi.string().trim().max(20).allow("", null),
  deliveryLat: Joi.number().min(-90).max(90).allow(null),
  deliveryLng: Joi.number().min(-180).max(180).allow(null),
  notes: Joi.string().trim().max(500).allow("", null),
});

/** Put the selected medicines into the existing cart instead of ordering now. */
const addPrescriptionToCart = Joi.object({ items: selection });

module.exports = {
  uploadAndShare,
  listRequests,
  updateStatus,
  submitAvailability,
  placeOrderFromPrescription,
  addPrescriptionToCart,
};