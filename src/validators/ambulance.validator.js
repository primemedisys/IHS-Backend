/**
 * Joi schemas for the Ambulance module (migration 040): provider signup and
 * portal, public discovery, patient bookings and the admin reads/decisions.
 * Validation lives ONLY here; controllers trust `req.body` /
 * `req.validatedQuery` and services only check business rules (status,
 * ownership, approval), never request shape.
 */
const Joi = require("joi");
const A = require("../config/ambulance");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);
const S = (max) => Joi.string().trim().max(max);
const OPT = (max) => S(max).allow("", null);
const NAME = S(150).min(2);
/** Same rule as the blood-bank / auth validators, so every portal accepts the same numbers. */
const PHONE = Joi.string()
  .trim()
  .pattern(/^[+]?[\d\s-]{7,20}$/)
  .messages({ "string.pattern.base": "Phone number is not valid" });
const EMAIL = Joi.string().trim().lowercase().email().max(190);
const PASSWORD = Joi.string()
  .min(8)
  .max(128)
  .pattern(/[A-Za-z]/, "letter")
  .pattern(/\d/, "number")
  .messages({
    "string.pattern.name": "Password must include at least one {#name}",
    "string.min": "Password must be at least 8 characters",
  });
const LAT = Joi.number().min(-90).max(90);
const LNG = Joi.number().min(-180).max(180);
const MONEY = Joi.number().precision(2).min(0).max(1000000);
const DAY = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ "string.pattern.base": "Use YYYY-MM-DD" });
const DATE = Joi.date().iso();
const TYPE = Joi.string().valid(...A.AMBULANCE_TYPE_KEYS);
const VERIFICATION = Joi.string().valid(...Object.values(A.AMBULANCE_VERIFICATION));
const BOOKING_STATUS = Joi.string().valid(...Object.values(A.AMBULANCE_BOOKING_STATUS));

/** Upper-case and strip spaces / dashes / dots so "od 02-ab 1234" and "OD02AB1234" are one vehicle. */
const normalizePlate = (value) => value.toUpperCase().replace(/[\s.-]/g, "");

/**
 * Indian vehicle number: state code + RTO + series + 4 digits (OD02AB1234), or
 * the Bharat series (22BH1234AB). Normalised before matching and storing.
 */
const VEHICLE_NUMBER = Joi.string()
  .trim()
  .max(20)
  .custom((value, helpers) => {
    const v = normalizePlate(value);
    const standard = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/;
    const bharat = /^\d{2}BH\d{4}[A-Z]{1,2}$/;
    if (!standard.test(v) && !bharat.test(v)) return helpers.error("any.invalid");
    return v;
  })
  .messages({ "any.invalid": "Vehicle number is not valid (e.g. OD02AB1234)" });

/** The RC / registration certificate number — alphanumeric, normalised like the plate. */
const REGISTRATION_NUMBER = Joi.string()
  .trim()
  .max(30)
  .custom((value, helpers) => {
    const v = normalizePlate(value).replace(/\//g, "");
    if (!/^[A-Z0-9]{5,30}$/.test(v)) return helpers.error("any.invalid");
    return v;
  })
  .messages({ "any.invalid": "Registration number must be 5–30 letters or digits" });

const LICENSE_NUMBER = Joi.string()
  .trim()
  .max(50)
  .custom((value, helpers) => {
    const v = value.toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9/-]{6,50}$/.test(v)) return helpers.error("any.invalid");
    return v;
  })
  .messages({ "any.invalid": "Driving licence number is not valid" });

// ── Provider / organisation ─────────────────────────────────────────────────

const organizationFields = {
  contactPerson: OPT(150),
  emergencyPhone: PHONE.allow("", null),
  district: OPT(100),
  is24x7: Joi.boolean(),
  about: OPT(1000),
};
const locationFields = {
  addressLine: OPT(255),
  city: OPT(100),
  state: OPT(100),
  pincode: Joi.string().trim().pattern(/^\d{6}$/).allow("", null).messages({ "string.pattern.base": "Pincode must be 6 digits" }),
  lat: LAT.allow(null),
  lng: LNG.allow(null),
};

// ── Ambulance (vehicle) ─────────────────────────────────────────────────────

/** Every editable ambulance field. `baseLat/baseLng` are required on create: search is by distance. */
const ambulanceFields = {
  registrationNumber: REGISTRATION_NUMBER,
  vehicleNumber: VEHICLE_NUMBER,
  ambulanceType: TYPE,
  vehicleModel: OPT(100),
  vehicleDetails: OPT(1000),
  capacity: Joi.number().integer().min(1).max(20).allow(null),
  equipment: Joi.array().items(Joi.string().valid(...A.AMBULANCE_EQUIPMENT_KEYS)).unique().max(A.AMBULANCE_EQUIPMENT_KEYS.length),
  serviceArea: OPT(255),
  serviceRadiusKm: Joi.number().integer().min(1).max(A.AMBULANCE_ESTIMATE.MAX_RADIUS_KM).allow(null),
  baseAddress: OPT(255),
  baseCity: OPT(100),
  baseState: OPT(100),
  basePincode: locationFields.pincode,
  baseLat: LAT,
  baseLng: LNG,
  isEmergencyAvailable: Joi.boolean(),
  baseFare: MONEY,
  perKmRate: MONEY,
  waitingChargePerHour: MONEY.allow(null),
  emergencySurcharge: MONEY.allow(null),
};
const ambulanceRequired = {
  registrationNumber: ambulanceFields.registrationNumber.required(),
  vehicleNumber: ambulanceFields.vehicleNumber.required(),
  ambulanceType: ambulanceFields.ambulanceType.required(),
  baseCity: S(100).min(1).required(),
  baseState: S(100).min(1).required(),
  baseLat: LAT.required(),
  baseLng: LNG.required(),
  baseFare: MONEY.required(),
  perKmRate: MONEY.required(),
};
const createAmbulance = Joi.object({ ...ambulanceFields, ...ambulanceRequired });
/**
 * Editing a vehicle's identity or type sends it back for admin review (the
 * service decides that); pricing / availability / equipment edits do not.
 */
const updateAmbulance = Joi.object(ambulanceFields).and("baseLat", "baseLng").min(1);
const setAvailability = Joi.object({
  availabilityStatus: Joi.string().valid(...A.AMBULANCE_MANUAL_AVAILABILITY).required(),
});
const setDefaultDriver = Joi.object({ driverId: ID.allow(null).required() });
const listAmbulances = Joi.object({
  verificationStatus: VERIFICATION,
  availabilityStatus: Joi.string().valid(...Object.values(A.AMBULANCE_AVAILABILITY)),
  ambulanceType: TYPE,
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
});

// ── Driver ──────────────────────────────────────────────────────────────────

const driverFields = {
  name: NAME,
  phone: PHONE,
  licenseNumber: LICENSE_NUMBER,
  licenseValidUntil: DAY.allow("", null),
  emergencyContactName: OPT(150),
  emergencyContactPhone: PHONE.allow("", null),
};
const createDriver = Joi.object({
  ...driverFields,
  name: NAME.required(),
  phone: PHONE.required(),
  licenseNumber: LICENSE_NUMBER.required(),
});
const updateDriver = Joi.object({ ...driverFields, isActive: Joi.boolean() }).min(1);
const listDrivers = Joi.object({ search: OPT(100), isActive: Joi.boolean(), page: PAGE, limit: LIMIT });

// ── Signup ──────────────────────────────────────────────────────────────────

/**
 * Provider + first ambulance (+ optional first driver), created atomically.
 * More ambulances / drivers are added from the portal afterwards.
 */
const register = Joi.object({
  /** The organisation name (it is the account name, like a clinic / blood bank). */
  name: NAME.required(),
  email: EMAIL.required(),
  phone: PHONE.required(),
  password: PASSWORD.required(),
  ...organizationFields,
  contactPerson: S(150).min(2).required(),
  ...locationFields,
  addressLine: S(255).min(2).required(),
  city: S(100).min(1).required(),
  state: S(100).min(1).required(),
  ambulance: createAmbulance.required(),
  driver: createDriver.allow(null),
});

const updateProfile = Joi.object({
  name: NAME,
  phone: PHONE,
  ...organizationFields,
  ...locationFields,
}).min(1);

// ── Public discovery ────────────────────────────────────────────────────────

const nearby = Joi.object({
  lat: LAT.required(),
  lng: LNG.required(),
  radiusKm: Joi.number().min(1).max(A.AMBULANCE_ESTIMATE.MAX_RADIUS_KM).default(A.AMBULANCE_ESTIMATE.DEFAULT_RADIUS_KM),
  ambulanceType: TYPE,
  emergency: Joi.boolean(),
  /** Optional destination — when given, each result carries an estimated trip fare. */
  dropLat: LAT,
  dropLng: LNG,
  page: PAGE,
  limit: Joi.number().integer().min(1).max(50).default(20),
}).and("dropLat", "dropLng");

/** Optional pickup (+ drop) so the details page can show distance / fare. */
const publicDetails = Joi.object({
  lat: LAT,
  lng: LNG,
  dropLat: LAT,
  dropLng: LNG,
  emergency: Joi.boolean(),
})
  .and("lat", "lng")
  .and("dropLat", "dropLng");

const estimate = Joi.object({
  pickupLat: LAT.required(),
  pickupLng: LNG.required(),
  dropLat: LAT.required(),
  dropLng: LNG.required(),
  emergency: Joi.boolean().default(false),
});

// ── Patient bookings ────────────────────────────────────────────────────────

const createBooking = Joi.object({
  ambulanceId: ID.required(),
  patientName: NAME.required(),
  contactPhone: PHONE.required(),
  pickupAddress: S(255).min(3).required(),
  pickupLat: LAT.required(),
  pickupLng: LNG.required(),
  dropAddress: S(255).min(3).required(),
  dropLat: LAT.required(),
  dropLng: LNG.required(),
  isEmergency: Joi.boolean().default(false),
  notes: OPT(1000),
});

/** `bucket` groups statuses the way both dashboards show them. */
const BUCKETS = ["new", "ongoing", "completed", "cancelled", "open"];
const listBookings = Joi.object({
  status: BOOKING_STATUS,
  bucket: Joi.string().valid(...BUCKETS),
  /** One vehicle's booking history (still scoped to the caller's own bookings). */
  ambulanceId: ID,
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
});
const patientCancel = Joi.object({ reason: OPT(500) });

// ── Provider booking actions ────────────────────────────────────────────────

const ETA = Joi.number().integer().min(1).max(600).allow(null);
const acceptBooking = Joi.object({ etaMinutes: ETA, note: OPT(500) });
const rejectBooking = Joi.object({ reason: S(500).min(2).required() });
const assignDriver = Joi.object({ driverId: ID.required(), etaMinutes: ETA });
const progressBooking = Joi.object({
  status: Joi.string().valid(...A.AMBULANCE_PROGRESS_STATUSES).required(),
  etaMinutes: ETA,
  note: OPT(500),
});
const completeBooking = Joi.object({
  actualDistanceKm: Joi.number().min(0).max(5000).precision(2).allow(null),
  waitingMinutes: Joi.number().integer().min(0).max(1440).allow(null),
  note: OPT(500),
});
const providerCancel = Joi.object({ reason: S(500).min(2).required() });

// ── Admin ───────────────────────────────────────────────────────────────────

const decision = Joi.string().valid(A.AMBULANCE_VERIFICATION.APPROVED, A.AMBULANCE_VERIFICATION.REJECTED).required();
const decisionNotes = Joi.when("decision", {
  is: A.AMBULANCE_VERIFICATION.REJECTED,
  then: S(500).min(2).required(),
  otherwise: OPT(500),
});
const adminVerifyProvider = Joi.object({
  decision,
  notes: decisionNotes,
  /** On approval, also approve the ambulances still pending review (default). */
  approvePendingAmbulances: Joi.boolean().default(true),
});
const adminVerifyAmbulance = Joi.object({ decision, notes: decisionNotes });
const adminSetActive = Joi.object({ isActive: Joi.boolean().required() });
const adminListProviders = Joi.object({ verificationStatus: VERIFICATION, search: OPT(100), page: PAGE, limit: LIMIT });
const adminListAmbulances = Joi.object({
  verificationStatus: VERIFICATION,
  availabilityStatus: Joi.string().valid(...Object.values(A.AMBULANCE_AVAILABILITY)),
  ambulanceType: TYPE,
  providerId: ID,
  isActive: Joi.boolean(),
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
});
const adminListBookings = Joi.object({
  status: BOOKING_STATUS,
  bucket: Joi.string().valid(...BUCKETS),
  providerId: ID,
  ambulanceId: ID,
  from: DATE,
  to: DATE.when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")) }),
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
});

module.exports = {
  BUCKETS,
  register,
  updateProfile,
  createAmbulance,
  updateAmbulance,
  setAvailability,
  setDefaultDriver,
  listAmbulances,
  createDriver,
  updateDriver,
  listDrivers,
  nearby,
  publicDetails,
  estimate,
  createBooking,
  listBookings,
  patientCancel,
  acceptBooking,
  rejectBooking,
  assignDriver,
  progressBooking,
  completeBooking,
  providerCancel,
  adminVerifyProvider,
  adminVerifyAmbulance,
  adminSetActive,
  adminListProviders,
  adminListAmbulances,
  adminListBookings,
};
