/**
 * OpenAPI paths for Doctor Dashboard 2.0 analytics + patient acquisition
 * sources (migration 056), merged into the spec by config/swagger.js.
 * Field-level reference: docs/doctor-dashboard-2-31-10-2026/api.md.
 */
const { BOOKING_STATUS, PAYMENT_STATUS, ACQUISITION_SOURCES } = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description) => ({ description, ...jsonBody(envelope({ type: "object" })) });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, description });

const TAG = "Doctor analytics";
const ATAG = "Patient acquisition";
const range = [
  query("from", { type: "string", format: "date" }, "IST day, inclusive (default: 1st of this month)"),
  query("to", { type: "string", format: "date" }, "IST day, inclusive (default: today). Max 366 days"),
  query("granularity", { type: "string", enum: ["day", "week", "month"] }, "Series bucket (daily capped at 92 days)"),
];
const paging = [query("page", { type: "integer", minimum: 1 }), query("limit", { type: "integer", minimum: 1, maximum: 100 })];
const denied = {
  400: errorResponse("Inverted or too-long range"),
  401: errorResponse("Not signed in"),
  403: errorResponse("Not a doctor"),
  422: errorResponse("Validation failed"),
};
const read = (summary, description, extra = []) => ({
  get: { tags: [TAG], summary, description, security: bearer, parameters: [...range, ...extra], responses: { 200: ok(summary), ...denied } },
});

const doctorAnalyticsPaths = {
  "/doctor/analytics/overview": read(
    "All overview KPI sections (patients, appointments, financial, quality, productivity, acquisition)",
    "Scoped to the signed-in doctor. Unrecorded metrics return { available: false, reason }."
  ),
  "/doctor/analytics/trends": read("Zero-filled revenue / appointment / patient / acquisition series"),
  "/doctor/analytics/patients": read("Patient analytics + paginated patient table", "", [
    query("segment", { type: "string", enum: ["all", "new", "returning"] }),
    query("search", { type: "string" }),
    ...paging,
  ]),
  "/doctor/analytics/appointments": read("Appointment analytics + paginated appointment table", "", [
    query("status", { type: "string", enum: Object.values(BOOKING_STATUS) }),
    query("mode", { type: "string", enum: ["clinic", "video"] }),
    ...paging,
  ]),
  "/doctor/analytics/financial": read(
    "Financial analytics + paginated transactions (doctor's own payments only)",
    "Collected = successful payments; refunded payments are excluded from collected and reported separately; pending = cash/UPI owed at the clinic.",
    [query("method", { type: "string", enum: ["online", "cash", "upi"] }), query("status", { type: "string", enum: Object.values(PAYMENT_STATUS) }), ...paging]
  ),
  "/doctor/analytics/quality": read("Documentation, follow-up compliance, completion; ratings/feedback reported as not tracked"),
  "/doctor/analytics/productivity": read("Consultations per day, duration, session adherence, utilization"),
  "/doctor/analytics/acquisition": read("New patients by original discovery source (period, previous period, all-time, monthly)"),
  "/patient/acquisition/sources": {
    get: {
      tags: [ATAG],
      summary: "The 'How did you hear about the doctor?' option catalogue",
      security: bearer,
      responses: { 200: ok("Groups and sources"), 401: errorResponse("Not signed in"), 403: errorResponse("Not a patient") },
    },
  },
  "/patient/acquisition/doctors/{doctorId}": {
    get: {
      tags: [ATAG],
      summary: "Whether this patient already gave an original source for the doctor",
      security: bearer,
      parameters: [{ name: "doctorId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: ok("{ answered, group, source }"), 401: errorResponse("Not signed in"), 403: errorResponse("Not a patient") },
    },
  },
};

/** The optional `acquisition` field accepted by POST /patient/bookings (documented here for reference). */
const AcquisitionAnswer = {
  type: "object",
  required: ["source"],
  properties: {
    source: { type: "string", enum: ACQUISITION_SOURCES.map((s) => s.value) },
    otherText: { type: "string", maxLength: 120 },
    referralDetails: { type: "string", maxLength: 160 },
    capturedVia: { type: "string", enum: ["web", "mobile"] },
    utm: { type: "object", properties: Object.fromEntries(["source", "medium", "campaign", "term", "content"].map((k) => [k, { type: "string" }])) },
  },
};

const doctorAnalyticsTags = [
  { name: TAG, description: "Doctor Dashboard 2.0 — KPIs and Explore More analytics (own practice only)" },
  { name: ATAG, description: "How patients discovered a doctor (migration 056). The answer is sent as `acquisition` on POST /patient/bookings." },
];

module.exports = { doctorAnalyticsPaths, doctorAnalyticsTags, AcquisitionAnswer };
