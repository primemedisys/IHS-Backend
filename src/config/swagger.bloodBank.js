/**
 * OpenAPI paths for the Blood Bank module (migration 039), merged into the
 * spec by config/swagger.js. Kept in its own file because the module is large;
 * enums come straight from config/bloodBank.js so the docs can't drift.
 */
const B = require("./bloodBank");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const idParam = { name: "id", in: "path", required: true, schema: { type: "integer" } };
const q = (name, schema, description) => ({ name, in: "query", schema, ...(description ? { description } : {}) });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const num = { type: "number" };
const date = { type: "string", format: "date" };
const dateTime = { type: "string", format: "date-time" };
const en = (values) => ({ type: "string", enum: [...values] });
const page = [q("page", { type: "integer", minimum: 1, default: 1 }), q("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 })];
const obj = (properties, required = []) => ({ type: "object", required, properties });

const GROUP = en(B.BLOOD_GROUPS);
const COMPONENT = en(B.BLOOD_COMPONENT_KEYS);

/**
 * One operation. Every route is JWT-authenticated; the role + gate are spelled
 * out in `who` so the Authorization of each endpoint reads at a glance.
 */
function op(tag, who, summary, description, { params = [], body, multipart, extra = {} } = {}) {
  return {
    tags: [tag],
    summary: `${who}: ${summary}`,
    description,
    security: bearer,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: jsonBody(body) } : {}),
    ...(multipart ? { requestBody: { content: { "multipart/form-data": { schema: multipart } } } } : {}),
    responses: {
      200: { description: "OK — `{ success, message, data }`" },
      401: errorResponse("Not authenticated"),
      403: errorResponse("Wrong role, not the owner, or (blood bank) not yet approved — code ONBOARDING_INCOMPLETE"),
      404: errorResponse("Not found (or owned by someone else)"),
      409: errorResponse("Conflict with the current state (already reserved / issued / used …)"),
      422: errorResponse("Validation or business-rule failure (details per field)"),
      ...extra,
    },
  };
}

const BANK = "Blood Bank";
const PATIENT = "Blood (patient)";
const ADMIN = "Admin – Blood Banks";
const APPROVED = "Blood bank (approved)";
const staff = (name) => ({ [name]: { ...str, description: "Name of the authorised staff member who performed / decided this step" } });

const centreProps = {
  centreType: en(Object.values(B.BLOOD_CENTRE_TYPES)),
  licenseNumber: str,
  licenseValidUntil: date,
  contactPerson: str,
  emergencyPhone: str,
  district: str,
  operatingHours: str,
  is24x7: bool,
  componentsOffered: { type: "array", items: COMPONENT },
  about: str,
  addressLine: str,
  city: str,
  state: str,
  pincode: str,
  lat: num,
  lng: num,
};

const bloodBankPaths = {
  // ── Auth ────────────────────────────────────────────────────────────────
  "/auth/blood-bank/register": {
    post: {
      ...op(BANK, "Public", "register a blood bank / blood centre", "Creates the users row (role blood_bank, Google location on the user) and its blood_bank_profiles row atomically. The bank starts `verification_status = pending`: it can sign in and edit its profile, but every operational route returns 403 until an admin approves it.", {
        body: obj({ name: { ...str, description: "Centre name" }, email: str, phone: str, password: str, ...centreProps }, ["name", "email", "phone", "password", "centreType", "contactPerson", "city", "state"]),
        extra: { 201: { description: "{ user, tokens, profile }" } },
      }),
      security: [],
    },
  },
  "/auth/blood-bank/login": {
    post: {
      ...op(BANK, "Public", "blood-bank portal login", "Only role blood_bank; any other account gets 401 (same error as a wrong password). Rate-limited.", {
        body: obj({ email: str, password: str }, ["email", "password"]),
      }),
      security: [],
    },
  },

  // ── Profile / dashboard ─────────────────────────────────────────────────
  "/blood-bank/profile": {
    get: op(BANK, "Blood bank (any status)", "own profile + verification status", "Open to a pending bank."),
    put: op(BANK, "Blood bank (any status)", "update own profile", "Name/phone/location on the user row, centre details on the profile. Audited.", {
      body: obj({ name: str, phone: str, ...centreProps }),
    }),
  },
  "/blood-bank/reference": {
    get: op(BANK, "Blood bank", "reference data", "Blood groups, components (+shelf life), statuses, and the REFERENCE compatibility tables."),
  },
  "/blood-bank/dashboard": {
    get: op(BANK, APPROVED, "dashboard cards + charts", "Runs the expiry sweep first. Cards: total/available/reserved units, pending testing, expiring soon, pending + emergency requests, today's donations/issues, donors. Charts: by group, by component, request status, 14-day donation/issue trends, expiring by day. Sends at most one 'expiring soon' notification per day."),
  },
  "/blood-bank/audit": {
    get: op(BANK, APPROVED, "audit trail", "The bank's own blood_audit_logs, newest first.", {
      params: [q("entityType", en(Object.values(B.BLOOD_AUDIT_ENTITY))), q("entityId", int), ...page],
    }),
  },

  // ── Donors ──────────────────────────────────────────────────────────────
  "/blood-bank/donors": {
    get: op(BANK, APPROVED, "list donors", "Only this bank's donors.", {
      params: [q("search", str, "name / phone / donor code"), q("bloodGroup", GROUP), q("status", en(Object.values(B.DONOR_STATUS))), ...page],
    }),
    post: op(BANK, APPROVED, "register donor", "Server-generated donor code DNR-YYYY-NNNNNN.", {
      body: obj({ name: str, phone: str, dateOfBirth: date, gender: en(B.GENDER_VALUES), email: str, addressLine: str, city: str, state: str, pincode: str, bloodGroup: GROUP, consentGiven: bool, notes: str, patientUserId: int }, ["name", "phone"]),
      extra: { 201: { description: "{ donor }" } },
    }),
  },
  "/blood-bank/donors/{id}": {
    get: op(BANK, APPROVED, "donor detail", "With screenings and donation history (+ units).", { params: [idParam] }),
    put: op(BANK, APPROVED, "edit donor", "A deferral can only change through a new screening record.", {
      params: [idParam],
      body: obj({ name: str, phone: str, bloodGroup: GROUP, status: en([B.DONOR_STATUS.ACTIVE, B.DONOR_STATUS.INACTIVE]), consentGiven: bool }),
    }),
  },
  "/blood-bank/donors/{id}/screenings": {
    post: op(BANK, APPROVED, "record a screening", "Records vitals and the DECISION made by authorised staff (the software never decides eligibility). The donor status mirrors the latest decision. Deferral = decision deferred_* + reason (+ until date for temporary).", {
      params: [idParam],
      body: obj({ screenedAt: dateTime, weightKg: num, hemoglobinGdl: num, bpSystolic: int, bpDiastolic: int, pulseBpm: int, temperatureC: num, questionnaireCleared: bool, decision: en(Object.values(B.SCREENING_DECISION)), deferralReason: str, deferredUntil: date, ...staff("screenedByName"), notes: str }, ["decision", "screenedByName"]),
      extra: { 201: { description: "{ screening }" } },
    }),
  },

  // ── Donations / testing ─────────────────────────────────────────────────
  "/blood-bank/donations": {
    get: op(BANK, APPROVED, "list donations", "", {
      params: [q("search", str, "donation code"), q("testingStatus", en(Object.values(B.TESTING_STATUS))), q("from", dateTime), q("to", dateTime), ...page],
    }),
    post: op(BANK, APPROVED, "record a donation", "Needs an ELIGIBLE screening of the same donor recorded ≤24h before collection (one donation per screening). Creates the donation (DON-…) and its whole-blood unit (UNIT-…, quarantine, expiry = collection + shelf life, or an earlier date given) in one transaction.", {
      body: obj({ donorId: int, screeningId: int, campId: int, collectedAt: dateTime, volumeMl: int, bagType: str, ...staff("collectedByName"), expiresAt: dateTime, storageLocation: str, notes: str }, ["donorId", "screeningId", "volumeMl", "collectedByName"]),
      extra: { 201: { description: "{ donation }" } },
    }),
  },
  "/blood-bank/donations/{id}": { get: op(BANK, APPROVED, "donation detail", "With donor, screening, tests and units.", { params: [idParam] }) },
  "/blood-bank/donations/{id}/tests": {
    post: op(BANK, APPROVED, "record a lab test result", "Recorded as entered by the person who performed it; moves quarantined units to `testing`. Refused once testing is decided.", {
      params: [idParam],
      body: obj({ testName: str, result: en(Object.values(B.TEST_RESULT)), resultValue: str, method: str, testedAt: dateTime, ...staff("performedByName"), notes: str }, ["testName", "result", "performedByName"]),
      extra: { 201: { description: "{ test }" } },
    }),
  },
  "/blood-bank/donations/{id}/testing": {
    put: op(BANK, APPROVED, "record the testing decision", "passed / failed as decided by authorised staff (≥1 result required). Failed discards every in-stock unit of the donation in the same transaction. Passed units still need an explicit release.", {
      params: [idParam],
      body: obj({ testingStatus: en([B.TESTING_STATUS.PASSED, B.TESTING_STATUS.FAILED]), ...staff("decidedByName"), notes: str }, ["testingStatus", "decidedByName"]),
    }),
  },

  // ── Units / inventory ───────────────────────────────────────────────────
  "/blood-bank/inventory": {
    get: op(BANK, APPROVED, "inventory grid", "Blood group × component: available, reserved, in testing, expiring soon, next expiry — one GROUP BY over blood_units after the expiry sweep.", {
      params: [q("bloodGroup", GROUP), q("component", COMPONENT)],
    }),
  },
  "/blood-bank/units": {
    get: op(BANK, APPROVED, "search units", "Server-side filters, sorting and paging.", {
      params: [q("unitCode", str), q("bloodGroup", GROUP), q("component", COMPONENT), q("status", en(Object.values(B.UNIT_STATUS))), q("expiring", bool, `within ${B.BLOOD_EXPIRY_WARNING_DAYS} days`), q("collectedFrom", dateTime), q("collectedTo", dateTime), q("expiresFrom", dateTime), q("expiresTo", dateTime), q("sort", en(["expiresAt", "-expiresAt", "collectedAt", "-collectedAt"])), ...page],
    }),
  },
  "/blood-bank/units/{id}": {
    get: op(BANK, APPROVED, "unit traceability", "Donation, donor code, parent/child units, reservations, cross-matches, issue and audit trail.", { params: [idParam] }),
    put: op(BANK, APPROVED, "update storage location", "", { params: [idParam], body: obj({ storageLocation: str }) }),
  },
  "/blood-bank/units/{id}/release": {
    post: op(BANK, APPROVED, "release to AVAILABLE", "Only a quarantine/testing unit whose donation testing was recorded as PASSED and that has not expired. Row-locked, audited.", {
      params: [idParam],
      body: obj({ ...staff("releasedByName"), storageLocation: str }, ["releasedByName"]),
    }),
  },
  "/blood-bank/units/{id}/discard": {
    post: op(BANK, APPROVED, "discard a unit", "Releases any active reservation on it. Audited.", {
      params: [idParam],
      body: obj({ reason: str, ...staff("discardedByName") }, ["reason", "discardedByName"]),
    }),
  },
  "/blood-bank/units/{id}/separate": {
    post: op(BANK, APPROVED, "separate whole blood into components", "Children get their own UNIT- numbers, inherit group/testing/stock state and a shelf-life expiry; the parent becomes `processed`.", {
      params: [idParam],
      body: obj({ components: { type: "array", items: obj({ component: COMPONENT, volumeMl: int, expiresAt: dateTime, storageLocation: str }, ["component"]) }, ...staff("processedByName") }, ["components", "processedByName"]),
      extra: { 201: { description: "{ units }" } },
    }),
  },

  // ── Requests ────────────────────────────────────────────────────────────
  "/blood-bank/requests": {
    get: op(BANK, APPROVED, "incoming requests", "Only requests sent to this bank; emergencies first.", {
      params: [q("status", en(Object.values(B.BLOOD_REQUEST_STATUS))), q("emergency", bool), q("bloodGroup", GROUP), q("search", str), q("from", dateTime), q("to", dateTime), ...page],
    }),
  },
  "/blood-bank/requests/{id}": {
    get: op(BANK, APPROVED, "request detail", "With reservations, cross-matches, issues, audit trail and REFERENCE compatibility (groups + available counts) — reference only.", { params: [idParam] }),
  },
  "/blood-bank/requests/{id}/document": {
    get: op(BANK, APPROVED, "stream the supporting document", "Private, no-store; never a public URL.", { params: [idParam] }),
  },
  "/blood-bank/requests/{id}/status": {
    put: op(BANK, APPROVED, "manual status step", "viewed / processing / available / rejected per BLOOD_REQUEST_BANK_TRANSITIONS. Rejecting releases active reservations. Patient notified.", {
      params: [idParam],
      body: obj({ status: en(["viewed", "processing", "available", "rejected"]), note: str }, ["status"]),
    }),
  },
  "/blood-bank/requests/{id}/reservations": {
    post: op(BANK, APPROVED, "reserve a unit", "Unit row locked (SELECT … FOR UPDATE) and re-checked: must be available, passed, unexpired, same component; capped at units required. A concurrent second reservation gets 409.", {
      params: [idParam],
      body: obj({ unitId: int, ...staff("reservedByName") }, ["unitId", "reservedByName"]),
    }),
  },
  "/blood-bank/requests/{id}/crossmatches": {
    post: op(BANK, APPROVED, "record a cross-match result", "The RESULT performed by qualified staff, for a unit reserved to this request. Never inferred by the software.", {
      params: [idParam],
      body: obj({ unitId: int, result: en(Object.values(B.CROSSMATCH_RESULT)), method: str, performedAt: dateTime, ...staff("performedByName"), notes: str }, ["unitId", "result", "performedByName"]),
      extra: { 201: { description: "{ request }" } },
    }),
  },
  "/blood-bank/requests/{id}/approve": {
    post: op(BANK, APPROVED, "authorised approval", "Only a reserved request whose every active reservation has a latest cross-match = compatible.", {
      params: [idParam],
      body: obj({ ...staff("approvedByName"), note: str }, ["approvedByName"]),
    }),
  },
  "/blood-bank/requests/{id}/issues": {
    post: op(BANK, APPROVED, "issue a unit", "One transaction: unit → issued, reservation → issued, issue record (ISS-…) with the cross-match reference; request → completed when all required units are issued. Expired units refused.", {
      params: [idParam],
      body: obj({ unitId: int, ...staff("issuedToName"), ...staff("issuedByName"), ...staff("verifiedByName"), issuedAt: dateTime, notes: str }, ["unitId", "issuedToName", "issuedByName", "verifiedByName"]),
      extra: { 201: { description: "{ request }" } },
    }),
  },
  "/blood-bank/reservations": {
    get: op(BANK, APPROVED, "reservation register", "", { params: [q("status", en(Object.values(B.RESERVATION_STATUS))), ...page] }),
  },
  "/blood-bank/reservations/{id}/release": {
    post: op(BANK, APPROVED, "cancel a reservation", "Unit returns to available stock (or expired).", { params: [idParam], body: obj({ reason: str }, ["reason"]) }),
  },
  "/blood-bank/crossmatches": {
    get: op(BANK, APPROVED, "cross-match register", "", { params: [q("result", en(Object.values(B.CROSSMATCH_RESULT))), ...page] }),
  },
  "/blood-bank/issues": {
    get: op(BANK, APPROVED, "issue register", "", { params: [q("from", dateTime), q("to", dateTime), ...page] }),
  },

  // ── Camps ───────────────────────────────────────────────────────────────
  "/blood-bank/camps": {
    get: op(BANK, APPROVED, "list camps", "", { params: [q("status", en(Object.values(B.CAMP_STATUS))), q("upcoming", bool), ...page] }),
    post: op(BANK, APPROVED, "create camp", "", {
      body: obj({ name: str, campDate: date, startTime: { ...str, example: "09:00" }, endTime: str, venue: str, city: str, state: str, organizer: str, contactPhone: str, description: str, capacity: int }, ["name", "campDate", "startTime", "endTime", "venue"]),
      extra: { 201: { description: "{ camp }" } },
    }),
  },
  "/blood-bank/camps/{id}": {
    get: op(BANK, APPROVED, "camp detail + registrations", "", { params: [idParam] }),
    put: op(BANK, APPROVED, "edit / complete / cancel camp", "Cancelling notifies registered patients.", {
      params: [idParam],
      body: obj({ name: str, campDate: date, status: en(Object.values(B.CAMP_STATUS)) }),
    }),
  },
  "/blood-bank/camps/{id}/registrations/{registrationId}": {
    put: op(BANK, APPROVED, "mark registration attended", "", {
      params: [idParam, { name: "registrationId", in: "path", required: true, schema: int }],
      body: obj({ status: en([B.CAMP_REGISTRATION_STATUS.ATTENDED, B.CAMP_REGISTRATION_STATUS.REGISTERED]) }, ["status"]),
    }),
  },

  // ── Patient ─────────────────────────────────────────────────────────────
  "/blood/reference": { get: op(PATIENT, "Patient", "reference data", "Groups, components, statuses, reference compatibility.") },
  "/blood/nearby": {
    get: op(PATIENT, "Patient", "nearby blood banks with availability", "Approved, active banks in the patient's Google city/state (same rule as pharmacies/labs). lat+lng (together) add a distance and sort by it. availableUnits = AVAILABLE, tested, unexpired units of the asked group+component — indicative; the bank confirms.", {
      params: [q("city", str), q("state", str), q("lat", num), q("lng", num), q("bloodGroup", GROUP), q("component", COMPONENT), q("search", str), ...page],
    }),
  },
  "/blood/banks/{id}": { get: op(PATIENT, "Patient", "blood bank public profile + available stock", "", { params: [idParam] }) },
  "/blood/requests": {
    get: op(PATIENT, "Patient", "my blood requests", "", { params: [q("status", en(Object.values(B.BLOOD_REQUEST_STATUS))), ...page] }),
    post: op(PATIENT, "Patient", "send a blood request", "To ONE approved bank. urgency=emergency flags it (bank notified as EMERGENCY). The optional document is stored via the existing storage driver and only streamed back to the two participants.", {
      multipart: obj({ bloodBankId: int, bloodGroup: GROUP, component: COMPONENT, unitsRequired: int, urgency: en(Object.values(B.BLOOD_URGENCY)), requiredBy: dateTime, patientName: str, hospitalName: str, hospitalAddress: str, doctorName: str, contactName: str, contactPhone: str, city: str, state: str, notes: str, document: { type: "string", format: "binary" } }, ["bloodBankId", "bloodGroup", "component", "unitsRequired", "patientName", "hospitalName", "contactName", "contactPhone"]),
      extra: { 201: { description: "{ request }" } },
    }),
  },
  "/blood/requests/{id}": { get: op(PATIENT, "Patient (owner)", "request detail", "With bank, reserved/issued unit codes.", { params: [idParam] }) },
  "/blood/requests/{id}/document": { get: op(PATIENT, "Patient (owner)", "stream my supporting document", "", { params: [idParam] }) },
  "/blood/requests/{id}/cancel": {
    post: op(PATIENT, "Patient (owner)", "cancel", "Only before anything is reserved (pending/viewed/processing/available).", { params: [idParam], body: obj({ reason: str }) }),
  },
  "/blood/history": { get: op(PATIENT, "Patient", "my blood history", "Requests, camp registrations, and donations a bank linked to my account.") },
  "/blood/camps": { get: op(PATIENT, "Patient", "upcoming camps", "Scheduled camps of approved banks.", { params: [q("city", str), q("state", str), ...page] }) },
  "/blood/camps/mine": { get: op(PATIENT, "Patient", "my camp registrations", "") },
  "/blood/camps/{id}/register": {
    post: op(PATIENT, "Patient", "register for a camp", "409 when already registered or the camp is full. Eligibility is decided by the camp's medical staff.", {
      params: [idParam],
      body: obj({ name: str, phone: str, bloodGroup: GROUP }, ["name", "phone"]),
      extra: { 201: { description: "{ registration }" } },
    }),
  },
  "/blood/camps/{id}/cancel": { post: op(PATIENT, "Patient", "cancel my camp registration", "", { params: [idParam] }) },

  // ── Admin ───────────────────────────────────────────────────────────────
  "/admin/blood-banks/summary": {
    get: op(ADMIN, "Admin", "blood bank statistics", "Banks (total/active/pending/rejected), donors, units by state, requests (pending/emergency/completed/by status), camps, and 14-day trends. Aggregates only."),
  },
  "/admin/blood-banks": {
    get: op(ADMIN, "Admin", "blood bank verification queue", "", {
      params: [q("verificationStatus", en(Object.values(B.BLOOD_BANK_VERIFICATION))), q("search", str), ...page],
    }),
  },
  "/admin/blood-banks/{id}": { get: op(ADMIN, "Admin", "one blood bank", "", { params: [idParam] }) },
  "/admin/blood-banks/{id}/verify": {
    post: op(ADMIN, "Admin", "approve / reject", "The bank is notified. Notes are required when rejecting.", {
      params: [idParam],
      body: obj({ decision: en([B.BLOOD_BANK_VERIFICATION.APPROVED, B.BLOOD_BANK_VERIFICATION.REJECTED]), notes: str }, ["decision"]),
    }),
  },
  "/admin/blood-banks/{id}/active": {
    patch: op(ADMIN, "Admin", "suspend / reinstate", "", { params: [idParam], body: obj({ isActive: bool }, ["isActive"]) }),
  },
  "/admin/blood-banks/inventory": {
    get: op(ADMIN, "Admin", "inventory by bank", "Counts per bank × group × component. No donor or patient data.", { params: [q("bloodBankId", int)] }),
  },
  "/admin/blood-banks/requests": {
    get: op(ADMIN, "Admin", "request ledger", "Workflow status + step times; no documents. Admin has no write access to requests or units.", {
      params: [q("status", en(Object.values(B.BLOOD_REQUEST_STATUS))), q("bloodBankId", int), q("emergency", bool), q("bloodGroup", GROUP), q("from", dateTime), q("to", dateTime), ...page],
    }),
  },
};

const bloodBankTags = [
  {
    name: BANK,
    description:
      "Blood Bank / Blood Centre portal: registration + admin approval, donors, screenings, donations, lab test records, units, inventory, expiry, requests, reservations, cross-matches, issues, camps, audit. The software RECORDS decisions of authorised staff; it never decides eligibility, test release, compatibility or transfusion.",
  },
  { name: PATIENT, description: "Patient blood-bank search, blood requests, camps and history" },
  { name: ADMIN, description: "Blood bank verification, suspension and read-only statistics" },
];

module.exports = { bloodBankPaths, bloodBankTags };
