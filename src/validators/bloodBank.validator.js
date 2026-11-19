/**
 * Joi schemas for the Blood Bank module (migration 039): the blood-bank portal,
 * the patient blood endpoints and the admin reads. Validation lives ONLY here;
 * controllers trust `req.body` / `req.validatedQuery` and services only check
 * business rules (status, ownership, stock), never request shape.
 */
const Joi = require("joi");
const B = require("../config/bloodBank");

const ID = Joi.alternatives(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/));
const PAGE = Joi.number().integer().min(1).default(1);
const LIMIT = Joi.number().integer().min(1).max(100).default(20);
const S = (max) => Joi.string().trim().max(max);
const OPT = (max) => S(max).allow("", null);
const NAME = S(150).min(2);
/** The name of the staff member who performed / authorised a step. */
const STAFF = S(150).min(2).required();
const PHONE = Joi.string()
  .trim()
  .pattern(/^[+]?[\d\s-]{7,20}$/)
  .messages({ "string.pattern.base": "Phone number is not valid" });
const GROUP = Joi.string().valid(...B.BLOOD_GROUPS);
const COMPONENT = Joi.string().valid(...B.BLOOD_COMPONENT_KEYS);
const DATE = Joi.date().iso();
const DAY = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ "string.pattern.base": "Use YYYY-MM-DD" });
const TIME = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).messages({ "string.pattern.base": "Use HH:MM" });
const LAT = Joi.number().min(-90).max(90).allow(null);
const LNG = Joi.number().min(-180).max(180).allow(null);
const range = { from: DATE, to: DATE.when("from", { is: Joi.exist(), then: Joi.date().greater(Joi.ref("from")) }) };

// ── Auth / profile ───────────────────────────────────────────────────────

/** Editable centre details (shared by signup and profile update). */
const centreFields = {
  centreType: Joi.string().valid(...Object.values(B.BLOOD_CENTRE_TYPES)),
  licenseNumber: OPT(100),
  licenseValidUntil: DAY.allow("", null),
  contactPerson: OPT(150),
  emergencyPhone: PHONE.allow("", null),
  district: OPT(100),
  operatingHours: OPT(150),
  is24x7: Joi.boolean(),
  componentsOffered: Joi.array().items(COMPONENT).unique().max(B.BLOOD_COMPONENT_KEYS.length),
  about: OPT(1000),
};
const locationFields = {
  addressLine: OPT(255),
  city: OPT(100),
  state: OPT(100),
  pincode: OPT(20),
  lat: LAT,
  lng: LNG,
};

const register = Joi.object({
  /** The blood bank / centre name (it is the account name, like a clinic). */
  name: NAME.required(),
  email: Joi.string().trim().lowercase().email().max(190).required(),
  phone: PHONE.required(),
  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(/[A-Za-z]/, "letter")
    .pattern(/\d/, "number")
    .required()
    .messages({
      "string.pattern.name": "Password must include at least one {#name}",
      "string.min": "Password must be at least 8 characters",
    }),
  ...centreFields,
  centreType: centreFields.centreType.required(),
  contactPerson: S(150).min(2).required(),
  ...locationFields,
  city: S(100).min(1).required(),
  state: S(100).min(1).required(),
});

const updateProfile = Joi.object({
  name: NAME,
  phone: PHONE,
  ...centreFields,
  ...locationFields,
}).min(1);

// ── Donors ───────────────────────────────────────────────────────────────

const donorFields = {
  name: NAME,
  dateOfBirth: DAY.allow(null),
  gender: Joi.string().valid(...B.GENDER_VALUES).allow(null),
  phone: PHONE,
  email: Joi.string().trim().lowercase().email().max(190).allow("", null),
  addressLine: OPT(255),
  city: OPT(100),
  state: OPT(100),
  pincode: OPT(20),
  bloodGroup: GROUP.allow(null),
  consentGiven: Joi.boolean(),
  notes: OPT(1000),
  /** Link to a registered patient (e.g. from a camp registration). */
  patientUserId: ID.allow(null),
};
const createDonor = Joi.object({ ...donorFields, name: NAME.required(), phone: PHONE.required() });
const updateDonor = Joi.object({
  ...donorFields,
  status: Joi.string().valid(B.DONOR_STATUS.ACTIVE, B.DONOR_STATUS.INACTIVE),
}).min(1);
const listDonors = Joi.object({
  search: OPT(100),
  bloodGroup: GROUP,
  status: Joi.string().valid(...Object.values(B.DONOR_STATUS)),
  page: PAGE,
  limit: LIMIT,
});

const screening = Joi.object({
  screenedAt: DATE.default(() => new Date()),
  weightKg: Joi.number().min(0).max(400).allow(null),
  hemoglobinGdl: Joi.number().min(0).max(30).allow(null),
  bpSystolic: Joi.number().integer().min(0).max(300).allow(null),
  bpDiastolic: Joi.number().integer().min(0).max(200).allow(null),
  pulseBpm: Joi.number().integer().min(0).max(300).allow(null),
  temperatureC: Joi.number().min(25).max(45).allow(null),
  questionnaireCleared: Joi.boolean().allow(null),
  decision: Joi.string().valid(...Object.values(B.SCREENING_DECISION)).required(),
  deferralReason: Joi.when("decision", {
    is: B.SCREENING_DECISION.ELIGIBLE,
    then: OPT(255),
    otherwise: S(255).min(2).required(),
  }),
  deferredUntil: Joi.when("decision", {
    is: B.SCREENING_DECISION.DEFERRED_TEMPORARY,
    then: DAY.required(),
    otherwise: DAY.allow("", null),
  }),
  screenedByName: STAFF,
  notes: OPT(1000),
});

// ── Donations / testing / units ──────────────────────────────────────────

const createDonation = Joi.object({
  donorId: ID.required(),
  screeningId: ID.required(),
  campId: ID.allow(null),
  collectedAt: DATE.default(() => new Date()),
  volumeMl: Joi.number().integer().min(50).max(1000).required(),
  bagType: OPT(50),
  collectedByName: STAFF,
  /** Optional shorter expiry than the component default (SOP / bag type). */
  expiresAt: DATE.allow(null),
  storageLocation: OPT(100),
  notes: OPT(1000),
});
const listDonations = Joi.object({
  search: OPT(100),
  testingStatus: Joi.string().valid(...Object.values(B.TESTING_STATUS)),
  ...range,
  page: PAGE,
  limit: LIMIT,
});

const addTest = Joi.object({
  testName: S(100).min(1).required(),
  result: Joi.string().valid(...Object.values(B.TEST_RESULT)).required(),
  resultValue: Joi.when("result", { is: B.TEST_RESULT.RECORDED, then: S(100).min(1).required(), otherwise: OPT(100) }),
  method: OPT(100),
  testedAt: DATE.default(() => new Date()),
  performedByName: STAFF,
  notes: OPT(500),
});

const testingDecision = Joi.object({
  testingStatus: Joi.string().valid(B.TESTING_STATUS.PASSED, B.TESTING_STATUS.FAILED).required(),
  decidedByName: STAFF,
  notes: OPT(500),
});

const separate = Joi.object({
  components: Joi.array()
    .items(
      Joi.object({
        component: Joi.string()
          .valid(...B.BLOOD_COMPONENT_KEYS.filter((k) => k !== "whole_blood"))
          .required(),
        volumeMl: Joi.number().integer().min(1).max(1000).allow(null),
        expiresAt: DATE.allow(null),
        storageLocation: OPT(100),
      })
    )
    .min(1)
    .max(6)
    .unique("component")
    .required(),
  processedByName: STAFF,
});

const releaseUnit = Joi.object({ releasedByName: STAFF, storageLocation: OPT(100) });
const discardUnit = Joi.object({ reason: S(255).min(2).required(), discardedByName: STAFF });
const updateUnit = Joi.object({ storageLocation: OPT(100) }).min(1);

const listUnits = Joi.object({
  unitCode: OPT(30),
  bloodGroup: GROUP,
  component: COMPONENT,
  status: Joi.string().valid(...Object.values(B.UNIT_STATUS)),
  expiring: Joi.boolean(),
  collectedFrom: DATE,
  collectedTo: DATE,
  expiresFrom: DATE,
  expiresTo: DATE,
  sort: Joi.string().valid("expiresAt", "-expiresAt", "collectedAt", "-collectedAt").default("expiresAt"),
  page: PAGE,
  limit: LIMIT,
});
const inventorySummary = Joi.object({ bloodGroup: GROUP, component: COMPONENT });

// ── Requests (bank side) ─────────────────────────────────────────────────

const listBankRequests = Joi.object({
  status: Joi.string().valid(...Object.values(B.BLOOD_REQUEST_STATUS)),
  emergency: Joi.boolean(),
  bloodGroup: GROUP,
  search: OPT(100),
  ...range,
  page: PAGE,
  limit: LIMIT,
});
const requestStatus = Joi.object({
  status: Joi.string()
    .valid(
      B.BLOOD_REQUEST_STATUS.VIEWED,
      B.BLOOD_REQUEST_STATUS.PROCESSING,
      B.BLOOD_REQUEST_STATUS.AVAILABLE,
      B.BLOOD_REQUEST_STATUS.REJECTED
    )
    .required(),
  note: OPT(500),
});
const reserve = Joi.object({ unitId: ID.required(), reservedByName: STAFF });
const releaseReservation = Joi.object({ reason: S(255).min(2).required() });
const crossmatch = Joi.object({
  unitId: ID.required(),
  result: Joi.string().valid(...Object.values(B.CROSSMATCH_RESULT)).required(),
  method: OPT(100),
  performedAt: DATE.default(() => new Date()),
  performedByName: STAFF,
  notes: OPT(500),
});
const approve = Joi.object({ approvedByName: STAFF, note: OPT(500) });
const issue = Joi.object({
  unitId: ID.required(),
  issuedToName: STAFF,
  issuedByName: STAFF,
  verifiedByName: STAFF,
  issuedAt: DATE.default(() => new Date()),
  notes: OPT(500),
});
const listIssues = Joi.object({ ...range, page: PAGE, limit: LIMIT });
const listReservations = Joi.object({
  status: Joi.string().valid(...Object.values(B.RESERVATION_STATUS)),
  page: PAGE,
  limit: LIMIT,
});
const listCrossmatches = Joi.object({
  result: Joi.string().valid(...Object.values(B.CROSSMATCH_RESULT)),
  page: PAGE,
  limit: LIMIT,
});

// ── Camps ────────────────────────────────────────────────────────────────

const campFields = {
  name: S(150).min(2),
  campDate: DAY,
  startTime: TIME,
  endTime: TIME,
  venue: S(255).min(2),
  city: OPT(100),
  state: OPT(100),
  organizer: OPT(150),
  contactPhone: PHONE.allow("", null),
  description: OPT(1000),
  capacity: Joi.number().integer().min(1).max(100000).allow(null),
};
const createCamp = Joi.object({
  ...campFields,
  name: campFields.name.required(),
  campDate: DAY.required(),
  startTime: TIME.required(),
  endTime: TIME.required(),
  venue: campFields.venue.required(),
});
const updateCamp = Joi.object({
  ...campFields,
  status: Joi.string().valid(...Object.values(B.CAMP_STATUS)),
}).min(1);
const listCamps = Joi.object({
  status: Joi.string().valid(...Object.values(B.CAMP_STATUS)),
  upcoming: Joi.boolean(),
  page: PAGE,
  limit: LIMIT,
});
const campRegistrationStatus = Joi.object({
  status: Joi.string().valid(B.CAMP_REGISTRATION_STATUS.ATTENDED, B.CAMP_REGISTRATION_STATUS.REGISTERED).required(),
});

const listAudit = Joi.object({
  entityType: Joi.string().valid(...Object.values(B.BLOOD_AUDIT_ENTITY)),
  entityId: ID,
  page: PAGE,
  limit: LIMIT,
});

// ── Patient ──────────────────────────────────────────────────────────────

const nearby = Joi.object({
  city: OPT(100),
  state: OPT(100),
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
  bloodGroup: GROUP,
  component: COMPONENT,
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
}).and("lat", "lng");

/** Multipart (document via upload.single("document", { required: false })). */
const createRequest = Joi.object({
  bloodBankId: ID.required(),
  bloodGroup: GROUP.required(),
  component: COMPONENT.required(),
  unitsRequired: Joi.number().integer().min(1).max(20).required(),
  urgency: Joi.string().valid(...Object.values(B.BLOOD_URGENCY)).default(B.BLOOD_URGENCY.ROUTINE),
  requiredBy: DATE.allow("", null),
  patientName: NAME.required(),
  hospitalName: S(200).min(2).required(),
  hospitalAddress: OPT(255),
  doctorName: OPT(150),
  contactName: NAME.required(),
  contactPhone: PHONE.required(),
  city: OPT(100),
  state: OPT(100),
  notes: OPT(1000),
});
const listMyRequests = Joi.object({
  status: Joi.string().valid(...Object.values(B.BLOOD_REQUEST_STATUS)),
  page: PAGE,
  limit: LIMIT,
});
const cancelRequest = Joi.object({ reason: OPT(500) });
const publicCamps = Joi.object({
  city: OPT(100),
  state: OPT(100),
  page: PAGE,
  limit: LIMIT,
});
const campRegister = Joi.object({
  name: NAME.required(),
  phone: PHONE.required(),
  bloodGroup: GROUP.allow(null),
});

// ── Admin ────────────────────────────────────────────────────────────────

const adminListBanks = Joi.object({
  verificationStatus: Joi.string().valid(...Object.values(B.BLOOD_BANK_VERIFICATION)),
  search: OPT(100),
  page: PAGE,
  limit: LIMIT,
});
const adminVerify = Joi.object({
  decision: Joi.string().valid(B.BLOOD_BANK_VERIFICATION.APPROVED, B.BLOOD_BANK_VERIFICATION.REJECTED).required(),
  notes: Joi.when("decision", {
    is: B.BLOOD_BANK_VERIFICATION.REJECTED,
    then: S(500).min(2).required(),
    otherwise: OPT(500),
  }),
});
const adminSetActive = Joi.object({ isActive: Joi.boolean().required() });
const adminListRequests = Joi.object({
  status: Joi.string().valid(...Object.values(B.BLOOD_REQUEST_STATUS)),
  bloodBankId: ID,
  emergency: Joi.boolean(),
  bloodGroup: GROUP,
  ...range,
  page: PAGE,
  limit: LIMIT,
});
const adminInventory = Joi.object({ bloodBankId: ID });

module.exports = {
  register,
  updateProfile,
  createDonor,
  updateDonor,
  listDonors,
  screening,
  createDonation,
  listDonations,
  addTest,
  testingDecision,
  separate,
  releaseUnit,
  discardUnit,
  updateUnit,
  listUnits,
  inventorySummary,
  listBankRequests,
  requestStatus,
  reserve,
  releaseReservation,
  crossmatch,
  approve,
  issue,
  listIssues,
  listReservations,
  listCrossmatches,
  createCamp,
  updateCamp,
  listCamps,
  campRegistrationStatus,
  listAudit,
  nearby,
  createRequest,
  listMyRequests,
  cancelRequest,
  publicCamps,
  campRegister,
  adminListBanks,
  adminVerify,
  adminSetActive,
  adminListRequests,
  adminInventory,
};
