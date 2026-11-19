/**
 * OpenAPI paths for doctor patient search + record-access consent (migration
 * 045), merged into the spec by config/swagger.js.
 *
 * Searching grants nothing. A doctor who does not treat a patient asks for ONE
 * category of the patient's uploaded records; the PATIENT approves by choosing
 * the exact documents (and for how long), or rejects, and can revoke. Shared
 * files are only ever streamed through the authorized route; every step is
 * written to access_audit_logs. Real-time: Socket.IO on the API origin, path
 * /socket.io, handshake auth { token: <access JWT> }, server event
 * "notification" carries one persisted notification row.
 */
const { ACCESS_CATEGORIES, ACCESS_GRANT_DAYS, ACCESS_REQUEST_STATUS } = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description, data) => ({ description, ...jsonBody(envelope(data)) });
const path = (name) => ({ name, in: "path", required: true, schema: { type: "integer" } });
const nstr = { type: "string", nullable: true };
const date = { type: "string", format: "date-time", nullable: true };

const TAG = "Record access (consent)";
const category = { type: "string", enum: ACCESS_CATEGORIES };
const status = { type: "string", enum: Object.values(ACCESS_REQUEST_STATUS) };

const RecordMeta = {
  type: "object",
  description: "Metadata only — a storage URL is never sent to the doctor.",
  properties: { id: { type: "string" }, fileType: category, tag: nstr, recordDate: nstr, uploadedAt: date, source: nstr },
};
const base = {
  id: { type: "string" },
  category,
  purpose: { type: "string" },
  status,
  active: { type: "boolean", description: "approved and not past grantExpiresAt" },
  createdAt: date,
  requestExpiresAt: date,
  decidedAt: date,
  decisionNote: nstr,
  grantExpiresAt: date,
  revokedAt: date,
  sharedCount: { type: "integer" },
};
const DoctorView = {
  type: "object",
  properties: {
    ...base,
    patient: { type: "object", nullable: true, properties: { id: { type: "string" }, name: nstr, photoUrl: nstr } },
    records: { type: "array", items: RecordMeta, description: "Only while the grant is active" },
  },
};
const PatientView = {
  type: "object",
  properties: {
    ...base,
    doctor: {
      type: "object",
      properties: {
        id: nstr,
        name: nstr,
        photoUrl: nstr,
        qualification: nstr,
        headline: nstr,
        verified: { type: "boolean" },
        specializations: { type: "array", items: { type: "string" } },
      },
    },
    sharedRecordIds: { type: "array", items: { type: "string" } },
    candidates: {
      type: "array",
      items: { type: "object", properties: { ...RecordMeta.properties, fileUrl: nstr } },
      description: "Detail only: the patient's own records of this category",
    },
  },
};
const page = (item) => ({
  type: "object",
  properties: {
    requests: { type: "array", items: item },
    total: { type: "integer" },
    page: { type: "integer" },
    limit: { type: "integer" },
    totalPages: { type: "integer" },
  },
});
const PatientRow = {
  type: "object",
  description: "Basic, non-medical fields. Phone and email are searchable but never returned.",
  properties: {
    id: { type: "string" },
    name: nstr,
    avatarUrl: nstr,
    gender: nstr,
    age: { type: "integer", nullable: true },
    city: nstr,
    treating: { type: "boolean" },
  },
};
const listParams = [
  { name: "status", in: "query", schema: status },
  { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
];
const common = {
  401: errorResponse("Not signed in"),
  403: errorResponse("Wrong role / unverified doctor (DOCTOR_NOT_VERIFIED)"),
};

const recordAccessPaths = {
  "/doctor/patient-search": {
    get: {
      tags: [TAG],
      summary: "Search patients (verified doctors only; rate limited; audited)",
      security: bearer,
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 3, maxLength: 120 },
          description: "Name, phone (6+ digits, suffix match) or exact email",
        },
      ],
      responses: {
        200: ok("Up to 20 matches", { type: "object", properties: { patients: { type: "array", items: PatientRow } } }),
        422: errorResponse("q shorter than 3 characters"),
        ...common,
      },
    },
  },
  "/doctor/patient-search/{patientId}": {
    get: {
      tags: [TAG],
      summary: "Basic card for one patient + this doctor's own requests (no medical data)",
      security: bearer,
      parameters: [path("patientId")],
      responses: {
        200: ok("Patient card", {
          type: "object",
          properties: { patient: PatientRow, treating: { type: "boolean" }, requests: { type: "array", items: DoctorView } },
        }),
        404: errorResponse("Not an active patient"),
        ...common,
      },
    },
  },
  "/doctor/access-requests": {
    post: {
      tags: [TAG],
      summary: "Ask a patient for one category of records (notifies the patient)",
      security: bearer,
      requestBody: {
        required: true,
        ...jsonBody({
          type: "object",
          required: ["patientId", "category", "purpose"],
          properties: { patientId: { type: "integer" }, category, purpose: { type: "string", minLength: 10, maxLength: 500 } },
        }),
      },
      responses: {
        201: ok("Pending request", DoctorView),
        404: errorResponse("Patient not found"),
        409: errorResponse("ACCESS_ALREADY_AUTHORIZED (you already treat this patient) or ACCESS_REQUEST_PENDING"),
        ...common,
      },
    },
    get: {
      tags: [TAG],
      summary: "The doctor's own requests",
      security: bearer,
      parameters: [{ name: "patientId", in: "query", schema: { type: "integer" } }, ...listParams],
      responses: { 200: ok("Page", page(DoctorView)), ...common },
    },
  },
  "/doctor/access-requests/{id}": {
    get: {
      tags: [TAG],
      summary: "One of the doctor's requests",
      security: bearer,
      parameters: [path("id")],
      responses: { 200: ok("Request", DoctorView), 404: errorResponse("Not this doctor's request"), ...common },
    },
  },
  "/doctor/access-requests/{id}/cancel": {
    post: {
      tags: [TAG],
      summary: "Withdraw a pending request",
      security: bearer,
      parameters: [path("id")],
      responses: { 200: ok("Cancelled", DoctorView), 409: errorResponse("ACCESS_REQUEST_CLOSED"), ...common },
    },
  },
  "/doctor/access-requests/{id}/records/{recordId}/file": {
    get: {
      tags: [TAG],
      summary: "Stream ONE shared document (re-checked and audited on every read; Cache-Control: private, no-store)",
      security: bearer,
      parameters: [path("id"), path("recordId")],
      responses: {
        200: { description: "The file" },
        401: errorResponse("Not signed in"),
        403: errorResponse("ACCESS_NOT_GRANTED — pending, rejected, revoked, expired, or not shared"),
        404: errorResponse("Not this doctor's request"),
      },
    },
  },
  "/patient/access-requests": {
    get: {
      tags: [TAG],
      summary: "Requests addressed to the signed-in patient",
      security: bearer,
      parameters: listParams,
      responses: { 200: ok("Page", page(PatientView)), ...common },
    },
  },
  "/patient/access-requests/{id}": {
    get: {
      tags: [TAG],
      summary: "Who asks, why, and the patient's own documents of that category",
      security: bearer,
      parameters: [path("id")],
      responses: { 200: ok("Request", PatientView), 404: errorResponse("Not this patient's request"), ...common },
    },
  },
  "/patient/access-requests/{id}/approve": {
    post: {
      tags: [TAG],
      summary: "Approve by sharing exactly these documents for N days (notifies the doctor)",
      security: bearer,
      parameters: [path("id")],
      requestBody: {
        required: true,
        ...jsonBody({
          type: "object",
          required: ["recordIds"],
          properties: {
            recordIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "integer" } },
            durationDays: { type: "integer", enum: ACCESS_GRANT_DAYS, default: 30 },
          },
        }),
      },
      responses: {
        200: ok("Approved", PatientView),
        400: errorResponse("A record is not the patient's own or not of the requested category"),
        409: errorResponse("ACCESS_REQUEST_CLOSED"),
        ...common,
      },
    },
  },
  "/patient/access-requests/{id}/reject": {
    post: {
      tags: [TAG],
      summary: "Decline (notifies the doctor)",
      security: bearer,
      parameters: [path("id")],
      requestBody: { ...jsonBody({ type: "object", properties: { note: { type: "string", maxLength: 500 } } }) },
      responses: { 200: ok("Rejected", PatientView), 409: errorResponse("ACCESS_REQUEST_CLOSED"), ...common },
    },
  },
  "/patient/access-requests/{id}/revoke": {
    post: {
      tags: [TAG],
      summary: "End an active approval now (notifies the doctor)",
      security: bearer,
      parameters: [path("id")],
      responses: { 200: ok("Revoked", PatientView), 409: errorResponse("Not an active approval"), ...common },
    },
  },
};

const recordAccessTags = [
  {
    name: TAG,
    description:
      "Doctors who don't treat a patient can find them and ask for one category of records. Only the patient's approval — of specific documents, for a limited time — grants access; it can be revoked. Every step is audited.",
  },
];

module.exports = { recordAccessPaths, recordAccessTags };
