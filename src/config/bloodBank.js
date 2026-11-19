/**
 * Blood Bank domain constants (migration 039). The ONE place blood groups,
 * components, statuses and reference tables are defined — the models, Joi
 * validators, services and Swagger all import from here, and the frontends
 * mirror these values.
 *
 * MEDICAL SAFETY: nothing in this file DECIDES anything. Shelf lives are
 * configurable defaults used to pre-compute an expiry date; the compatibility
 * tables are REFERENCE information shown to qualified staff. Eligibility,
 * test release, cross-match results and issue are always recorded decisions
 * made by authorised blood-bank personnel.
 */

const BLOOD_GROUPS = Object.freeze(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);

/**
 * Blood components with their DEFAULT shelf life (days from collection). A
 * centre may record a SHORTER expiry per unit (its SOP / bag type), never a
 * longer one. Add a component here to make it available everywhere.
 */
const BLOOD_COMPONENTS = Object.freeze({
  whole_blood: { label: "Whole Blood", shelfLifeDays: 35 },
  prbc: { label: "PRBC / Red Blood Cells", shelfLifeDays: 42 },
  platelets: { label: "Platelets", shelfLifeDays: 5 },
  plasma: { label: "Plasma (FFP)", shelfLifeDays: 365 },
});
const BLOOD_COMPONENT_KEYS = Object.freeze(Object.keys(BLOOD_COMPONENTS));

/** Units whose expiry falls within this many days are "expiring soon". */
const BLOOD_EXPIRY_WARNING_DAYS = 7;

/**
 * Red-cell compatibility (recipient → acceptable donor groups) and plasma
 * compatibility. REFERENCE ONLY — shown to staff; a unit is issued only after
 * a cross-match RESULT recorded by qualified personnel.
 */
const RED_CELL_COMPATIBILITY = Object.freeze({
  "O-": ["O-"],
  "O+": ["O+", "O-"],
  "A-": ["A-", "O-"],
  "A+": ["A+", "A-", "O+", "O-"],
  "B-": ["B-", "O-"],
  "B+": ["B+", "B-", "O+", "O-"],
  "AB-": ["AB-", "A-", "B-", "O-"],
  "AB+": ["AB+", "AB-", "A+", "A-", "B+", "B-", "O+", "O-"],
});
const PLASMA_COMPATIBILITY = Object.freeze({
  "O-": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
  "O+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
  "A-": ["A-", "A+", "AB-", "AB+"],
  "A+": ["A-", "A+", "AB-", "AB+"],
  "B-": ["B-", "B+", "AB-", "AB+"],
  "B+": ["B-", "B+", "AB-", "AB+"],
  "AB-": ["AB-", "AB+"],
  "AB+": ["AB-", "AB+"],
});

const BLOOD_CENTRE_TYPES = Object.freeze({
  HOSPITAL_BASED: "hospital_based",
  STANDALONE: "standalone",
  GOVERNMENT: "government",
  CHARITABLE: "charitable",
});

/** blood_bank_profiles.verification_status — same trio as clinic_profiles. */
const BLOOD_BANK_VERIFICATION = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

const GENDER_VALUES = Object.freeze(["male", "female", "other"]);

/** blood_donors.status — the RECORDED outcome of the latest screening. */
const DONOR_STATUS = Object.freeze({
  ACTIVE: "active",
  DEFERRED_TEMPORARY: "deferred_temporary",
  DEFERRED_PERMANENT: "deferred_permanent",
  INACTIVE: "inactive",
});

/** blood_donor_screenings.decision — entered by staff, never computed. */
const SCREENING_DECISION = Object.freeze({
  ELIGIBLE: "eligible",
  DEFERRED_TEMPORARY: "deferred_temporary",
  DEFERRED_PERMANENT: "deferred_permanent",
});

const DONATION_STATUS = Object.freeze({
  COLLECTED: "collected",
  PROCESSED: "processed",
  DISCARDED: "discarded",
});

/** Rolled-up lab screening outcome of a donation, set by staff. */
const TESTING_STATUS = Object.freeze({
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
});

/** blood_units.status — the inventory lifecycle. */
const UNIT_STATUS = Object.freeze({
  QUARANTINE: "quarantine",
  TESTING: "testing",
  AVAILABLE: "available",
  RESERVED: "reserved",
  ISSUED: "issued",
  TRANSFERRED: "transferred",
  /** A whole-blood unit separated into component units (kept for traceability). */
  PROCESSED: "processed",
  DISCARDED: "discarded",
  EXPIRED: "expired",
});
/** Units still physically held (expiry sweep applies to these). */
const UNIT_IN_STOCK = Object.freeze([
  UNIT_STATUS.QUARANTINE,
  UNIT_STATUS.TESTING,
  UNIT_STATUS.AVAILABLE,
  UNIT_STATUS.RESERVED,
]);
/** Units that can still be discarded by staff. */
const UNIT_DISCARDABLE = UNIT_IN_STOCK;

const TEST_RESULT = Object.freeze({
  NON_REACTIVE: "non_reactive",
  REACTIVE: "reactive",
  INDETERMINATE: "indeterminate",
  /** Free-value tests (e.g. grouping) record the value in `resultValue`. */
  RECORDED: "recorded",
});

/**
 * blood_requests.status. Emergency is a FLAG (`is_emergency`) rather than a
 * status, so an emergency request still moves through the same lifecycle.
 */
const BLOOD_REQUEST_STATUS = Object.freeze({
  PENDING: "pending",
  VIEWED: "viewed",
  PROCESSING: "processing",
  AVAILABLE: "available",
  RESERVED: "reserved",
  APPROVED: "approved",
  REJECTED: "rejected",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});
const BLOOD_REQUEST_OPEN = Object.freeze([
  BLOOD_REQUEST_STATUS.PENDING,
  BLOOD_REQUEST_STATUS.VIEWED,
  BLOOD_REQUEST_STATUS.PROCESSING,
  BLOOD_REQUEST_STATUS.AVAILABLE,
  BLOOD_REQUEST_STATUS.RESERVED,
  BLOOD_REQUEST_STATUS.APPROVED,
]);
/** Manual status moves the blood bank may make (reserve/approve/issue have their own actions). */
const BLOOD_REQUEST_BANK_TRANSITIONS = Object.freeze({
  [BLOOD_REQUEST_STATUS.PENDING]: [BLOOD_REQUEST_STATUS.VIEWED, BLOOD_REQUEST_STATUS.PROCESSING, BLOOD_REQUEST_STATUS.REJECTED],
  [BLOOD_REQUEST_STATUS.VIEWED]: [BLOOD_REQUEST_STATUS.PROCESSING, BLOOD_REQUEST_STATUS.AVAILABLE, BLOOD_REQUEST_STATUS.REJECTED],
  [BLOOD_REQUEST_STATUS.PROCESSING]: [BLOOD_REQUEST_STATUS.AVAILABLE, BLOOD_REQUEST_STATUS.REJECTED],
  [BLOOD_REQUEST_STATUS.AVAILABLE]: [BLOOD_REQUEST_STATUS.PROCESSING, BLOOD_REQUEST_STATUS.REJECTED],
  [BLOOD_REQUEST_STATUS.RESERVED]: [BLOOD_REQUEST_STATUS.REJECTED],
  [BLOOD_REQUEST_STATUS.APPROVED]: [BLOOD_REQUEST_STATUS.REJECTED],
});
/** A patient may cancel only before anything has been reserved for them. */
const BLOOD_REQUEST_PATIENT_CANCELLABLE = Object.freeze([
  BLOOD_REQUEST_STATUS.PENDING,
  BLOOD_REQUEST_STATUS.VIEWED,
  BLOOD_REQUEST_STATUS.PROCESSING,
  BLOOD_REQUEST_STATUS.AVAILABLE,
]);

const BLOOD_URGENCY = Object.freeze({
  ROUTINE: "routine",
  URGENT: "urgent",
  EMERGENCY: "emergency",
});

const RESERVATION_STATUS = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
  ISSUED: "issued",
});

/** Recorded by qualified staff — the software never infers it. */
const CROSSMATCH_RESULT = Object.freeze({
  COMPATIBLE: "compatible",
  INCOMPATIBLE: "incompatible",
});

const CAMP_STATUS = Object.freeze({
  SCHEDULED: "scheduled",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});
const CAMP_REGISTRATION_STATUS = Object.freeze({
  REGISTERED: "registered",
  CANCELLED: "cancelled",
  ATTENDED: "attended",
});

/** Human-readable, gapless, per-year reference prefixes (blood_counters). */
const BLOOD_CODE_PREFIX = Object.freeze({
  DONOR: "DNR",
  DONATION: "DON",
  UNIT: "UNIT",
  REQUEST: "BRQ",
  ISSUE: "ISS",
});

/** medicine_notifications.reference_type values used by the blood module. */
const BLOOD_NOTIFICATION_REF = Object.freeze({
  REQUEST: "blood_request",
  CAMP: "blood_camp",
  INVENTORY: "blood_inventory",
  PROFILE: "blood_bank_profile",
});

/** blood_audit_logs.entity_type */
const BLOOD_AUDIT_ENTITY = Object.freeze({
  PROFILE: "profile",
  DONOR: "donor",
  SCREENING: "screening",
  DONATION: "donation",
  UNIT: "unit",
  TEST: "test",
  REQUEST: "request",
  RESERVATION: "reservation",
  CROSSMATCH: "crossmatch",
  ISSUE: "issue",
  CAMP: "camp",
});

module.exports = {
  BLOOD_GROUPS,
  BLOOD_COMPONENTS,
  BLOOD_COMPONENT_KEYS,
  BLOOD_EXPIRY_WARNING_DAYS,
  RED_CELL_COMPATIBILITY,
  PLASMA_COMPATIBILITY,
  BLOOD_CENTRE_TYPES,
  BLOOD_BANK_VERIFICATION,
  GENDER_VALUES,
  DONOR_STATUS,
  SCREENING_DECISION,
  DONATION_STATUS,
  TESTING_STATUS,
  UNIT_STATUS,
  UNIT_IN_STOCK,
  UNIT_DISCARDABLE,
  TEST_RESULT,
  BLOOD_REQUEST_STATUS,
  BLOOD_REQUEST_OPEN,
  BLOOD_REQUEST_BANK_TRANSITIONS,
  BLOOD_REQUEST_PATIENT_CANCELLABLE,
  BLOOD_URGENCY,
  RESERVATION_STATUS,
  CROSSMATCH_RESULT,
  CAMP_STATUS,
  CAMP_REGISTRATION_STATUS,
  BLOOD_CODE_PREFIX,
  BLOOD_NOTIFICATION_REF,
  BLOOD_AUDIT_ENTITY,
};
