/**
 * Joi schemas for the patient's medicine routines, doses and reminder
 * settings (migration 055). No schema accepts a patient id — ownership always
 * comes from the signed-in user.
 */
const Joi = require("joi");
const {
  MEDICINE_TYPES,
  MEDICINE_TIMINGS,
  PATIENT_MEDICINE_SOURCES,
  PATIENT_MEDICINE_STATUS,
  DOSE_STATUS,
  DOSE_ACTIONS,
  DOSE_ACTION_SOURCES,
  DOSE_SNOOZE_MINUTES,
  MAX_REMINDER_TIMES,
  MAX_MEDICINES_PER_REQUEST,
} = require("../config/constants");
const { TIME_RE, isValidTimeZone } = require("../utils/medicineSchedule");

const SAFE = (max) => Joi.string().trim().max(max);
const ID = Joi.string().pattern(/^\d{1,20}$/);
const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message("must be a date (YYYY-MM-DD)");
const TIMEZONE = Joi.string()
  .max(64)
  .custom((v, helpers) => (isValidTimeZone(v) ? v : helpers.message("must be a valid time zone")));
const REMINDER_TIMES = Joi.array()
  .items(Joi.string().pattern(TIME_RE).message("must be a time (HH:MM, 24-hour)"))
  .max(MAX_REMINDER_TIMES)
  .unique();
const DAYS = Joi.array().items(Joi.number().integer().min(0).max(6)).max(7).unique().allow(null);

/** One medicine in the "add medicines" cart. */
const medicineItem = Joi.object({
  clientRequestId: Joi.string().trim().max(64).pattern(/^[A-Za-z0-9_-]+$/),
  // Picked from the catalogue → identity comes from it; otherwise typed in.
  medicineMasterId: ID,
  medicineName: Joi.when("medicineMasterId", {
    is: Joi.exist(),
    then: SAFE(200).allow("", null),
    otherwise: SAFE(200).min(2).required(),
  }),
  genericName: SAFE(255).allow("", null),
  strength: SAFE(100).allow("", null),
  dosageForm: Joi.string().valid(...MEDICINE_TYPES).allow(null),
  dose: SAFE(100).allow("", null),
  frequency: SAFE(100).allow("", null),
  foodTiming: Joi.string().valid(...MEDICINE_TIMINGS).allow(null),
  reminderTimes: REMINDER_TIMES.default([]),
  daysOfWeek: DAYS,
  startDate: DATE.required(),
  durationDays: Joi.number().integer().min(1).max(3650).allow(null),
  instructions: SAFE(500).allow("", null),
  reminderEnabled: Joi.boolean(),
});

const createMedicines = Joi.object({
  items: Joi.array().items(medicineItem).min(1).max(MAX_MEDICINES_PER_REQUEST).required(),
  timezone: TIMEZONE,
});

/** Prescribed fields are accepted here and refused by the service for prescribed routines. */
const updateMedicine = Joi.object({
  medicineName: SAFE(200).min(2),
  genericName: SAFE(255).allow("", null),
  strength: SAFE(100).allow("", null),
  dosageForm: Joi.string().valid(...MEDICINE_TYPES).allow(null),
  dose: SAFE(100).allow("", null),
  frequency: SAFE(100).allow("", null),
  foodTiming: Joi.string().valid(...MEDICINE_TIMINGS).allow(null),
  reminderTimes: REMINDER_TIMES,
  daysOfWeek: DAYS,
  startDate: DATE,
  durationDays: Joi.number().integer().min(1).max(3650).allow(null),
  instructions: SAFE(500).allow("", null),
  reminderEnabled: Joi.boolean(),
  timezone: TIMEZONE,
}).min(1);

const setStatus = Joi.object({
  status: Joi.string()
    .valid(PATIENT_MEDICINE_STATUS.ACTIVE, PATIENT_MEDICINE_STATUS.PAUSED, PATIENT_MEDICINE_STATUS.CANCELLED)
    .required(),
});

const doseAction = Joi.object({
  action: Joi.string().valid(...Object.values(DOSE_ACTIONS)).required(),
  snoozeMinutes: Joi.when("action", {
    is: DOSE_ACTIONS.SNOOZE,
    then: Joi.number().valid(...DOSE_SNOOZE_MINUTES).required(),
    otherwise: Joi.forbidden(),
  }),
  source: Joi.string().valid(...DOSE_ACTION_SOURCES).default("web"),
  /** When a queued offline action really happened (bounded by the service). */
  actedAt: Joi.date().iso(),
});

const updateSettings = Joi.object({
  privacyMode: Joi.boolean(),
  webReminders: Joi.boolean(),
  defaultSnoozeMinutes: Joi.number().valid(...DOSE_SNOOZE_MINUTES),
  timezone: TIMEZONE,
}).min(1);

const listQuery = Joi.object({
  status: Joi.string().valid(...Object.values(PATIENT_MEDICINE_STATUS)),
  source: Joi.string().valid(...Object.values(PATIENT_MEDICINE_SOURCES)),
});

const searchQuery = Joi.object({ q: SAFE(100).min(2).required() });

/** At most 8 days per request — enough for the mobile rolling window. */
const dosesQuery = Joi.object({
  from: Joi.date().iso(),
  to: Joi.date().iso().when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")).required() }),
}).custom((v, helpers) =>
  v.from && v.to && v.to.getTime() - v.from.getTime() > 8 * 24 * 60 * 60 * 1000
    ? helpers.message("the range can be at most 8 days")
    : v
);

const historyQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(30),
  patientMedicineId: ID,
  status: Joi.string().valid(...Object.values(DOSE_STATUS)),
});

const idParams = Joi.object({ id: ID.required() });
const doseParams = Joi.object({ doseId: ID.required() });

module.exports = {
  createMedicines,
  updateMedicine,
  setStatus,
  doseAction,
  updateSettings,
  listQuery,
  searchQuery,
  dosesQuery,
  historyQuery,
  idParams,
  doseParams,
};
