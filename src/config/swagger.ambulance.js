/**
 * OpenAPI paths for the Ambulance module (migration 040), merged into the spec
 * by config/swagger.js. Enums come straight from config/ambulance.js so the
 * docs can't drift from the validators.
 */
const A = require("./ambulance");

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

const TYPE = en(A.AMBULANCE_TYPE_KEYS);
const VERIFICATION = en(Object.values(A.AMBULANCE_VERIFICATION));
const AVAILABILITY = en(Object.values(A.AMBULANCE_AVAILABILITY));
const BOOKING_STATUS = en(Object.values(A.AMBULANCE_BOOKING_STATUS));
const BUCKET = en(["new", "ongoing", "completed", "cancelled", "open"]);

/** One operation; `who` spells out the role + gate so authorization reads at a glance. */
function op(tag, who, summary, description, { params = [], body, extra = {}, isPublic = false } = {}) {
  return {
    tags: [tag],
    summary: `${who}: ${summary}`,
    description,
    ...(isPublic ? { security: [] } : { security: bearer }),
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: jsonBody(body) } : {}),
    responses: {
      200: { description: "OK — `{ success, message, data }`" },
      ...(isPublic ? {} : { 401: errorResponse("Not authenticated") }),
      403: errorResponse("Wrong role, or (provider) not yet approved — code ONBOARDING_INCOMPLETE"),
      404: errorResponse("Not found, not visible, or owned by someone else"),
      409: errorResponse("Conflict with the current state (VEHICLE_IN_USE, AMBULANCE_UNAVAILABLE, DRIVER_BUSY …)"),
      422: errorResponse("Validation failure (details per field) or OUTSIDE_SERVICE_AREA"),
      ...extra,
    },
  };
}

const PROVIDER = "Ambulance Provider";
const PUBLIC = "Ambulance (public & patient)";
const ADMIN = "Admin – Ambulances";
const APPROVED = "Ambulance provider (approved)";

const ambulanceProps = {
  registrationNumber: { ...str, description: "RC number — normalised (upper-case, no spaces), unique" },
  vehicleNumber: { ...str, description: "Plate, e.g. OD02AB1234 or 22BH1234AB — normalised, unique" },
  ambulanceType: TYPE,
  vehicleModel: str,
  vehicleDetails: str,
  capacity: int,
  equipment: { type: "array", items: en(A.AMBULANCE_EQUIPMENT_KEYS) },
  serviceArea: str,
  serviceRadiusKm: int,
  baseAddress: str,
  baseCity: str,
  baseState: str,
  basePincode: str,
  baseLat: num,
  baseLng: num,
  isEmergencyAvailable: bool,
  baseFare: num,
  perKmRate: num,
  waitingChargePerHour: num,
  emergencySurcharge: num,
};
const ambulanceRequired = ["registrationNumber", "vehicleNumber", "ambulanceType", "baseCity", "baseState", "baseLat", "baseLng", "baseFare", "perKmRate"];
const driverProps = {
  name: str,
  phone: str,
  licenseNumber: str,
  licenseValidUntil: date,
  emergencyContactName: str,
  emergencyContactPhone: str,
};
const orgProps = {
  contactPerson: str,
  emergencyPhone: str,
  district: str,
  is24x7: bool,
  about: str,
  addressLine: str,
  city: str,
  state: str,
  pincode: str,
  lat: num,
  lng: num,
};
const bookingListParams = [q("status", BOOKING_STATUS), q("bucket", BUCKET, "new | ongoing | completed | cancelled (incl. rejected) | open"), q("search", str), ...page];

const ambulancePaths = {
  // ── Auth ──────────────────────────────────────────────────────────────
  "/auth/ambulance/register": {
    post: op(PROVIDER, "Public", "register an ambulance provider", "Creates, atomically: the users row (role ambulance_provider, address + Google location on the user), the ambulance_provider_profiles row, the FIRST ambulance, and optionally a first driver. Provider and ambulance start `pending` — nothing is publicly visible until an admin approves.", {
      isPublic: true,
      body: obj(
        {
          name: { ...str, description: "Organisation name" },
          email: str,
          phone: str,
          password: str,
          ...orgProps,
          ambulance: obj(ambulanceProps, ambulanceRequired),
          driver: obj(driverProps, ["name", "phone", "licenseNumber"]),
        },
        ["name", "email", "phone", "password", "contactPerson", "addressLine", "city", "state", "ambulance"]
      ),
      extra: { 201: { description: "{ user, tokens, profile }" } },
    }),
  },
  "/auth/ambulance/login": {
    post: op(PROVIDER, "Public", "ambulance portal login", "Only role ambulance_provider; any other account gets 401 (same error as a wrong password). Rate-limited. A pending provider can sign in.", {
      isPublic: true,
      body: obj({ email: str, password: str }, ["email", "password"]),
    }),
  },

  // ── Provider portal ───────────────────────────────────────────────────
  "/ambulance/profile": {
    get: op(PROVIDER, "Provider (any status)", "own profile + verification status", "Open to a pending / rejected provider."),
    put: op(PROVIDER, "Provider (any status)", "update own profile", "Organisation name/phone/location on the user row, the rest on the profile.", { body: obj({ name: str, phone: str, ...orgProps }) }),
  },
  "/ambulance/profile/resubmit": {
    post: op(PROVIDER, "Provider (rejected)", "resubmit for verification", "Moves a REJECTED provider back to pending after it corrected its details. 409 otherwise."),
  },
  "/ambulance/reference": { get: op(PROVIDER, "Provider", "reference data", "Types, equipment, statuses, the transition table and estimate settings.") },
  "/ambulance/dashboard": {
    get: op(PROVIDER, APPROVED, "dashboard", "Fleet counts (total, pending approval, active, available, on trip, offline), driver counts, booking counts (new / ongoing / completed / cancelled / today) and the 5 newest open bookings."),
  },
  "/ambulance/ambulances": {
    get: op(PROVIDER, APPROVED, "list own ambulances", "Only this provider's vehicles.", {
      params: [q("verificationStatus", VERIFICATION), q("availabilityStatus", AVAILABILITY), q("ambulanceType", TYPE), q("search", str), ...page],
    }),
    post: op(PROVIDER, APPROVED, "add an ambulance", "Starts `pending` — invisible to patients until an admin approves it.", { body: obj(ambulanceProps, ambulanceRequired), extra: { 201: { description: "{ ambulance }" } } }),
  },
  "/ambulance/ambulances/{id}": {
    get: op(PROVIDER, APPROVED, "one own ambulance", "", { params: [idParam] }),
    put: op(PROVIDER, APPROVED, "edit an ambulance", "Pricing / equipment / base location edits apply immediately. Changing registration number, vehicle number or type of an APPROVED ambulance — or editing a REJECTED one — sends it back to `pending` review.", { params: [idParam], body: obj(ambulanceProps) }),
  },
  "/ambulance/ambulances/{id}/availability": {
    put: op(PROVIDER, APPROVED, "set availability", "available / offline / maintenance. `on_trip` is set and cleared only by the booking workflow (409 while on a trip).", {
      params: [idParam],
      body: obj({ availabilityStatus: en(A.AMBULANCE_MANUAL_AVAILABILITY) }, ["availabilityStatus"]),
    }),
  },
  "/ambulance/ambulances/{id}/driver": {
    put: op(PROVIDER, APPROVED, "set the default driver", "The driver pre-selected when assigning a trip. `null` clears it.", { params: [idParam], body: obj({ driverId: { type: "integer", nullable: true } }, ["driverId"]) }),
  },
  "/ambulance/drivers": {
    get: op(PROVIDER, APPROVED, "list drivers", "Each row carries `currentTrip` when the driver is on an active booking.", { params: [q("search", str), q("isActive", bool), ...page] }),
    post: op(PROVIDER, APPROVED, "add a driver", "Licence number unique per provider.", { body: obj(driverProps, ["name", "phone", "licenseNumber"]), extra: { 201: { description: "{ driver }" } } }),
  },
  "/ambulance/drivers/{id}": {
    get: op(PROVIDER, APPROVED, "one driver", "", { params: [idParam] }),
    put: op(PROVIDER, APPROVED, "edit / deactivate a driver", "A driver on an active trip can't be deactivated (409 DRIVER_BUSY).", { params: [idParam], body: obj({ ...driverProps, isActive: bool }) }),
  },
  "/ambulance/bookings": { get: op(PROVIDER, APPROVED, "booking requests & trips", "Only this provider's bookings, newest first.", { params: bookingListParams }) },
  "/ambulance/bookings/{id}": { get: op(PROVIDER, APPROVED, "one booking + status history", "", { params: [idParam] }) },
  "/ambulance/bookings/{id}/accept": {
    post: op(PROVIDER, APPROVED, "accept (requested → accepted)", "The ambulance must be approved, active and `available`; it becomes `on_trip`. Optional provider ETA.", { params: [idParam], body: obj({ etaMinutes: int, note: str }) }),
  },
  "/ambulance/bookings/{id}/reject": {
    post: op(PROVIDER, APPROVED, "reject (requested → rejected)", "Reason required; the patient is notified.", { params: [idParam], body: obj({ reason: str }, ["reason"]) }),
  },
  "/ambulance/bookings/{id}/assign-driver": {
    post: op(PROVIDER, APPROVED, "assign / reassign driver", "accepted → driver_assigned, or change the driver while still driver_assigned. Driver must be own, active and not on another trip (409 DRIVER_BUSY).", { params: [idParam], body: obj({ driverId: int, etaMinutes: int }, ["driverId"]) }),
  },
  "/ambulance/bookings/{id}/status": {
    post: op(PROVIDER, APPROVED, "advance the trip", "driver_assigned → en_route → arrived → patient_picked_up, checked against the transition table (400 INVALID_STATUS_TRANSITION).", {
      params: [idParam],
      body: obj({ status: en(A.AMBULANCE_PROGRESS_STATUSES), etaMinutes: int, note: str }, ["status"]),
    }),
  },
  "/ambulance/bookings/{id}/complete": {
    post: op(PROVIDER, APPROVED, "complete (patient_picked_up → completed)", "Optional actual km / waiting minutes; the server computes final_fare and frees the ambulance.", { params: [idParam], body: obj({ actualDistanceKm: num, waitingMinutes: int, note: str }) }),
  },
  "/ambulance/bookings/{id}/cancel": {
    post: op(PROVIDER, APPROVED, "cancel", "Allowed until the patient is picked up. Reason required; frees the ambulance.", { params: [idParam], body: obj({ reason: str }, ["reason"]) }),
  },

  // ── Public discovery + patient bookings ───────────────────────────────
  "/ambulances/reference": { get: op(PUBLIC, "Public", "ambulance types & statuses", "Types, equipment, booking statuses and the happy-path flow.", { isPublic: true }) },
  "/ambulances/nearby": {
    get: op(PUBLIC, "Public", "nearby ambulances", "Only approved + active ambulances of approved + active providers, within both the search radius and the ambulance's own service radius of the pickup. Ordered available-first then nearest. `distanceKm` / `etaMinutes` are ESTIMATES from the ambulance's base (no live GPS). With dropLat/dropLng each result also carries an `estimate` (fare). Each result carries `baseLat` / `baseLng` (the registered base) for the patient map; `offline` / `maintenance` ambulances are never returned.", {
      isPublic: true,
      params: [
        q("lat", num, "pickup latitude (required)"),
        q("lng", num, "pickup longitude (required)"),
        q("radiusKm", num),
        q("ambulanceType", TYPE),
        q("emergency", bool, "only ambulances that take emergencies"),
        q("dropLat", num),
        q("dropLng", num),
        ...page,
      ],
    }),
  },
  "/ambulances/{id}": {
    get: op(PUBLIC, "Public", "one ambulance", "404 unless publicly visible. Optional pickup/drop add distance, ETA and fare.", {
      isPublic: true,
      params: [idParam, q("lat", num), q("lng", num), q("dropLat", num), q("dropLng", num), q("emergency", bool)],
    }),
  },
  "/ambulances/{id}/estimate": {
    get: op(PUBLIC, "Public", "trip estimate", "base fare + estimated km × per-km (+ emergency surcharge). The same function the booking uses.", {
      isPublic: true,
      params: [idParam, q("pickupLat", num), q("pickupLng", num), q("dropLat", num), q("dropLng", num), q("emergency", bool)],
    }),
  },
  "/ambulances/bookings": {
    post: op(PUBLIC, "Patient", "book an ambulance", "Ambulance must be visible AND available, the pickup inside its service area (422 OUTSIDE_SERVICE_AREA), and no open booking by this patient on the same ambulance. Fare computed and snapshotted server-side. Status `requested`; patient + provider notified.", {
      body: obj(
        {
          ambulanceId: int,
          patientName: str,
          contactPhone: str,
          pickupAddress: str,
          pickupLat: num,
          pickupLng: num,
          dropAddress: str,
          dropLat: num,
          dropLng: num,
          isEmergency: bool,
          notes: str,
        },
        ["ambulanceId", "patientName", "contactPhone", "pickupAddress", "pickupLat", "pickupLng", "dropAddress", "dropLat", "dropLng"]
      ),
      extra: { 201: { description: "{ booking }" } },
    }),
    get: op(PUBLIC, "Patient", "my ambulance bookings", "Only the caller's bookings.", { params: bookingListParams }),
  },
  "/ambulances/bookings/{id}": {
    get: op(PUBLIC, "Patient", "one of my bookings + status history", "The driver's phone is included only while the trip is live.", { params: [idParam] }),
  },
  "/ambulances/bookings/{id}/cancel": {
    post: op(PUBLIC, "Patient", "cancel my booking", "Only before the ambulance leaves (requested / accepted / driver_assigned).", { params: [idParam], body: obj({ reason: str }) }),
  },

  // ── Admin ─────────────────────────────────────────────────────────────
  "/admin/ambulances/summary": {
    get: op(ADMIN, "Admin", "ambulance overview", "Provider counts (total / pending / approved / rejected / suspended), ambulance counts (pending / approved / active / available / unavailable / on trip / deactivated), booking counts, by-type and by-status breakdowns, 14-day booking trend."),
  },
  "/admin/ambulance-providers": {
    get: op(ADMIN, "Admin", "provider verification queue", "", { params: [q("verificationStatus", VERIFICATION), q("search", str), ...page] }),
  },
  "/admin/ambulance-providers/{id}": { get: op(ADMIN, "Admin", "one provider + fleet + drivers", "", { params: [idParam] }) },
  "/admin/ambulance-providers/{id}/verify": {
    post: op(ADMIN, "Admin", "approve / reject a provider", "Notes required on rejection. On approval, pending ambulances are approved too unless approvePendingAmbulances=false.", {
      params: [idParam],
      body: obj({ decision: en([A.AMBULANCE_VERIFICATION.APPROVED, A.AMBULANCE_VERIFICATION.REJECTED]), notes: str, approvePendingAmbulances: bool }, ["decision"]),
    }),
  },
  "/admin/ambulance-providers/{id}/active": {
    patch: op(ADMIN, "Admin", "suspend / reinstate a provider", "Hides all its ambulances from search while suspended.", { params: [idParam], body: obj({ isActive: bool }, ["isActive"]) }),
  },
  "/admin/ambulances": {
    get: op(ADMIN, "Admin", "all ambulances", "Search by vehicle / registration number, city or provider name.", {
      params: [q("verificationStatus", VERIFICATION), q("availabilityStatus", AVAILABILITY), q("ambulanceType", TYPE), q("providerId", int), q("isActive", bool), q("search", str), ...page],
    }),
  },
  "/admin/ambulances/{id}": { get: op(ADMIN, "Admin", "one ambulance", "", { params: [idParam] }) },
  "/admin/ambulances/{id}/verify": {
    post: op(ADMIN, "Admin", "approve / reject one ambulance", "Notes required on rejection.", {
      params: [idParam],
      body: obj({ decision: en([A.AMBULANCE_VERIFICATION.APPROVED, A.AMBULANCE_VERIFICATION.REJECTED]), notes: str }, ["decision"]),
    }),
  },
  "/admin/ambulances/{id}/active": {
    patch: op(ADMIN, "Admin", "deactivate / reactivate one ambulance", "", { params: [idParam], body: obj({ isActive: bool }, ["isActive"]) }),
  },
  "/admin/ambulance-bookings": {
    get: op(ADMIN, "Admin", "booking monitoring", "Read-only ledger: patient, ambulance, provider, driver, pickup, destination, status, fare, times.", {
      params: [q("status", BOOKING_STATUS), q("bucket", BUCKET), q("providerId", int), q("ambulanceId", int, "booking history of one ambulance"), q("from", dateTime), q("to", dateTime), q("search", str), ...page],
    }),
  },
  "/admin/ambulance-bookings/{id}": { get: op(ADMIN, "Admin", "one booking + status history", "", { params: [idParam] }) },
};

const ambulanceTags = [
  {
    name: PROVIDER,
    description:
      "Ambulance providers: signup (organisation + first ambulance + driver), their own portal (fleet, availability, pricing, drivers) and the booking workflow. Every operational route requires an APPROVED provider.",
  },
  { name: PUBLIC, description: "Public ambulance discovery (no login) and the patient's own bookings (patient login)." },
  { name: ADMIN, description: "Provider + ambulance verification, suspension / deactivation, booking monitoring and statistics." },
];

module.exports = { ambulancePaths, ambulanceTags };
