/**
 * Joi schemas for the clinics + availability endpoints. The ONLY place these
 * request shapes are validated — controllers trust `req.body`/`req.query`
 * completely. Slot limits come from config/constants so the model default and
 * these schemas never drift.
 *
 * NOTE: overlap BETWEEN slots (and between clinic and online windows) is allowed
 * on purpose — a doctor can offer video and an in-clinic visit in the same hour;
 * the real conflict is only enforced at booking time (README §6).
 */
const Joi = require("joi");
const { MAX_SLOTS_PER_SCHEDULE, SLOT_DEFAULT_MINUTES } = require("../config/constants");

/** "HH:mm" 24-hour clock. */
const HHMM = Joi.string()
  .pattern(/^([01]\d|2[0-3]):[0-5]\d$/)
  .messages({ "string.pattern.base": '"{#label}" must be a time in "HH:mm" format' });

// ── Clinics ─────────────────────────────────────────────────────────────────
/**
 * A pin is all-or-nothing: lat and lng are both numbers, both null (a typed
 * address with no pin), or — on PATCH — both omitted. Half a coordinate is
 * never stored.
 */
function coordinatesTogether(value, helpers) {
  const state = (v) => (v === undefined ? "omitted" : v === null ? "cleared" : "set");
  if (state(value.lat) !== state(value.lng)) {
    return helpers.message('"lat" and "lng" must be set or cleared together');
  }
  return value;
}

const createClinic = Joi.object({
  name: Joi.string().trim().max(150).required(),
  addressLine: Joi.string().trim().max(255).required(),
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
  pincode: Joi.string().trim().max(20).allow("", null),
  // Coordinates are OPTIONAL: a doctor can type the address without a Google
  // Maps pin (migration 047). When sent, both must be sent together.
  lat: Joi.number().min(-90).max(90).allow(null).default(null),
  lng: Joi.number().min(-180).max(180).allow(null).default(null),
  phone: Joi.string().trim().max(20).allow("", null),
  offlineFee: Joi.number().min(0).required(),
}).custom(coordinatesTogether, "lat/lng together");

// Every create field optional + an is_active toggle; at least one key required.
const updateClinic = Joi.object({
  name: Joi.string().trim().max(150),
  addressLine: Joi.string().trim().max(255),
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
  pincode: Joi.string().trim().max(20).allow("", null),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
  phone: Joi.string().trim().max(20).allow("", null),
  offlineFee: Joi.number().min(0),
  isActive: Joi.boolean(),
})
  .min(1)
  .custom(coordinatesTogether, "lat/lng together");

// ── Availability (a weekly slot; the replace-the-set body wraps many) ────────
const weeklySlot = Joi.object({
  dayOfWeek: Joi.number().integer().min(0).max(6).required(),
  startTime: HHMM.required(),
  endTime: HHMM.required(),
  // Since the consultation queue this is EXPECTED MINUTES PER PATIENT — it
  // seeds the waiting estimate and no longer limits how many may book.
  slotDurationMinutes: Joi.number().integer().min(5).max(240).default(SLOT_DEFAULT_MINUTES),
  // Optional cap on tokens for a day built from this window; null = unlimited,
  // which is the default and the point of the feature.
  maxBookings: Joi.number().integer().min(1).max(500).allow(null).default(null),
}).custom((value, helpers) => {
  if (value.endTime <= value.startTime) return helpers.error("any.invalid");
  return value;
}, "end-after-start");

const setAvailability = Joi.object({
  // empty array is allowed → "clear this schedule"; the completeness rule
  // enforces "≥1 window somewhere" separately.
  slots: Joi.array().items(weeklySlot).max(MAX_SLOTS_PER_SCHEDULE).required(),
});

// ── Exceptions ──────────────────────────────────────────────────────────────
const createException = Joi.object({
  clinicId: Joi.number().integer().positive().allow(null).default(null), // null = online
  exceptionDate: Joi.date().iso().required(),
  reason: Joi.string().trim().max(255).allow("", null),
});

module.exports = {
  createClinic,
  updateClinic,
  setAvailability,
  createException,
};
