/**
 * Reusable user data-access helpers. Anything about *fetching or shaping a user*
 * that more than one flow needs lives here — so auth, admin, doctor and patient
 * features all share ONE implementation of "find by email", "load with profile",
 * and "create the role profile row" instead of each re-writing them.
 */
const { Op, col, fn, where: sqlWhere } = require("sequelize");
const {
  User,
  DoctorProfile,
  PatientProfile,
  ClinicProfile,
  BloodBankProfile,
  AmbulanceProviderProfile,
} = require("../models");
const { ROLES } = require("../config/constants");
const { normalizeIndianMobile } = require("../utils/phone");

/** Look up a user by email. Pass `withPassword` only for credential checks. */
function findByEmail(email, { withPassword = false } = {}) {
  const scoped = withPassword ? User.scope("withPassword") : User;
  return scoped.findOne({ where: { email } });
}

/**
 * Every account of the given roles whose stored phone IS this mobile number
 * (canonical 10 digits — see utils/phone). `users.phone` is free text and not
 * unique, so this returns a LIST and the caller decides what ambiguity means.
 *
 * SQL narrows on the last 10 digits with separators stripped; the JS pass then
 * re-checks with the real normaliser so "+1 …9876543210" can never match.
 * `limit` caps the work a caller does per request (e.g. bcrypt per candidate).
 */
async function findByMobile(mobile, roles, { withPassword = false, limit = 10 } = {}) {
  const scoped = withPassword ? User.scope("withPassword") : User;
  const stripped = fn("REPLACE", fn("REPLACE", fn("REPLACE", col("phone"), " ", ""), "-", ""), "+", "");
  const rows = await scoped.findAll({
    where: {
      role: { [Op.in]: roles },
      [Op.and]: [sqlWhere(fn("RIGHT", stripped, 10), mobile)],
    },
    order: [["id", "ASC"]],
    limit: limit + 1, // one extra so the caller can tell "more than limit"
  });
  return rows.filter((u) => normalizeIndianMobile(u.phone) === mobile);
}

/**
 * The eager-load spec for a user's role-specific profile. Returned as an
 * `include` array so callers load the profile in the SAME query — never a
 * second round trip / query-in-a-loop.
 */
function profileInclude(role) {
  if (role === ROLES.DOCTOR) return [{ model: DoctorProfile, as: "doctorProfile" }];
  if (role === ROLES.PATIENT) return [{ model: PatientProfile, as: "patientProfile" }];
  if (role === ROLES.CLINIC) return [{ model: ClinicProfile, as: "clinicProfile" }];
  if (role === ROLES.BLOOD_BANK) return [{ model: BloodBankProfile, as: "bloodBankProfile" }];
  if (role === ROLES.AMBULANCE_PROVIDER) {
    return [{ model: AmbulanceProviderProfile, as: "ambulanceProviderProfile" }];
  }
  return [];
}

/** Load a user together with their role profile in one query. */
function findWithProfile(userId, role) {
  return User.findByPk(userId, { include: profileInclude(role) });
}

/**
 * Create the role-specific profile row for a freshly-created user, inside an
 * existing transaction. Shared by local signup, Google signup, and admin-create.
 *
 * `overrides` lets a caller seed extra columns on the profile row — e.g. the
 * admin-create path stamps `verificationStatus:'approved'` + `isSubmitted:true`
 * so the doctor is live immediately (docs/admin-portal §6). Self-signup passes
 * nothing, so the row keeps its defaults (verification_status='pending').
 */
async function createProfileRow(user, tx, overrides = {}) {
  if (user.role === ROLES.DOCTOR) {
    // registration_number is NOT NULL + UNIQUE; seed a placeholder until the
    // doctor supplies a real one during verification.
    await DoctorProfile.create(
      { userId: user.id, registrationNumber: `PENDING-${user.id}`, ...overrides },
      { transaction: tx }
    );
  } else if (user.role === ROLES.PATIENT) {
    await PatientProfile.create({ userId: user.id, ...overrides }, { transaction: tx });
  } else if (user.role === ROLES.CLINIC) {
    // The signup form's "name" IS the clinic name — there is no separate person
    // behind a clinic account. Phone is copied so the profile starts with the
    // contact the clinic already gave us; both stay editable afterwards.
    await ClinicProfile.create(
      { userId: user.id, clinicName: user.name, phone: user.phone || null, ...overrides },
      { transaction: tx }
    );
  }
  if (user.role === ROLES.BLOOD_BANK) {
    // Like a clinic, the signup "name" IS the centre name. The blood-bank
    // signup passes the centre details as `overrides`; a bare /auth/register
    // still gets a valid pending row it can complete from its profile page.
    await BloodBankProfile.create(
      { userId: user.id, centreName: user.name, phone: user.phone || null, ...overrides },
      { transaction: tx }
    );
  }
  if (user.role === ROLES.AMBULANCE_PROVIDER) {
    // Same shape as the blood bank: the signup "name" IS the organisation
    // name; the ambulance signup passes the organisation details as overrides.
    await AmbulanceProviderProfile.create(
      { userId: user.id, organizationName: user.name, phone: user.phone || null, ...overrides },
      { transaction: tx }
    );
  }
  // Pharmacy providers (medicine store / clinic, hospital, and the retired MR)
  // have no separate profile table — their data lives on the users row.
}

/** Escape LIKE wildcards so a literal % or _ matches itself, not everything. */
const escapeLike = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * `phone` with spaces, dashes, brackets and the leading + stripped, in SQL.
 *
 * Numbers are stored however the patient typed them ("+91 98765 43210",
 * "9876543210", "98765-43210"), so comparing the raw column against a typed
 * number misses more often than it hits.
 */
const normalizedPhone = fn(
  "REPLACE",
  fn("REPLACE", fn("REPLACE", fn("REPLACE", col("phone"), " ", ""), "-", ""), "+", ""),
  "(",
  ""
);

/**
 * Decide what the clinic typed and match accordingly.
 *
 *   contains "@"   → EXACT email match
 *   ≥6 digits      → phone, matched on its trailing digits
 *   anything else  → a name substring
 *
 * The email branch is exact by design. A substring search on email would turn
 * this endpoint into an address harvester ("find every patient at gmail.com"),
 * which is precisely what the directory must never be — and the serializer
 * still never RETURNS an email, so a clinic can only confirm an address it
 * already knows.
 *
 * The phone branch compares the last SUBSCRIBER_DIGITS digits of both sides, so
 * a country code on either the typed number or the stored one doesn't matter:
 * "+91 98765 43210", "919876543210" and "9876543210" all find the same patient.
 * Comparing the full string instead fails whichever side carries the prefix.
 *
 * It is a suffix match, not a substring: you still need essentially the whole
 * number, so this is not a reverse lookup either.
 */
const SUBSCRIBER_DIGITS = 10; // Indian mobile numbers, ignoring any country code

function identifierWhere(term) {
  if (term.includes("@")) {
    return { email: term.toLowerCase() };
  }

  const digits = term.replace(/\D/g, "");
  if (digits.length >= 6) {
    const subscriber = digits.slice(-SUBSCRIBER_DIGITS);
    return {
      [Op.and]: [sqlWhere(normalizedPhone, { [Op.like]: `%${escapeLike(subscriber)}` })],
    };
  }

  return { name: { [Op.like]: `%${escapeLike(term)}%` } };
}

/**
 * The patient directory behind `GET /clinic/patients`.
 *
 * This is the ONE place `role='patient' AND is_active=1` is expressed, and the
 * only endpoint in the platform that enumerates patients — the doctor roster is
 * deliberately derived from a doctor's own bookings instead. It is therefore
 * gated twice over: `authorize(ROLES.CLINIC)` and `requireApprovedClinic`.
 *
 * `q` is interpreted by shape — see `identifierWhere`. Phone and email are
 * SEARCHABLE but neither is ever returned in a row (the serializer omits both),
 * so this can't be used as a reverse lookup for contact details. An empty `q`
 * browses everyone, which is the accepted product decision.
 *
 * PatientProfile is a hasOne, so the join can't fan out and `count` stays exact.
 */
async function searchPatients({ q = "", page = 1, pageSize = 20 } = {}) {
  const base = { role: ROLES.PATIENT, isActive: true };

  const term = String(q).trim();
  const where = term ? { ...base, ...identifierWhere(term) } : base;

  const { rows, count } = await User.findAndCountAll({
    where,
    include: [{ model: PatientProfile, as: "patientProfile" }],
    order: [
      ["name", "ASC"],
      ["id", "ASC"],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    data: rows,
    page,
    pageSize,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / pageSize)),
  };
}

module.exports = {
  findByEmail,
  findByMobile,
  profileInclude,
  findWithProfile,
  createProfileRow,
  searchPatients,
};
