/**
 * OpenAPI paths for the doctor EMR workspace + the patient's medical profile
 * (migration 051), merged into the spec by config/swagger.js.
 *
 * The visit/encounter is the existing booking. READ routes are patient-keyed
 * and require a real doctor–patient relationship (a confirmed/completed
 * booking); WRITE routes go through a booking the doctor owns. Prescriptions
 * and follow-ups keep their existing endpoints (/doctor/prescriptions,
 * /doctor/bookings/:id/follow-up), which now accept the extra optional fields.
 */
const {
  CLINICAL_ENTRY_KINDS,
  CLINICAL_ENTRY_STATUS,
  DIAGNOSIS_TYPES,
  INVESTIGATION_TYPES,
  ORDER_PRIORITIES,
  DOCTOR_NOTE_TYPES,
} = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description, data) => ({ description, ...jsonBody(envelope(data)) });
const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "integer" } });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, description });
const nstr = { type: "string", nullable: true };
const nnum = { type: "number", nullable: true };
const obj = (properties) => ({ type: "object", properties });

const TAG = "Doctor EMR workspace";
const PTAG = "Patient medical profile";
const denied = {
  401: errorResponse("Not signed in"),
  403: errorResponse("Wrong role, or the visit is an unpaid hold"),
  404: errorResponse("Patient/visit not found — or not one this doctor treats (never confirmed either way)"),
};

const PatientLite = obj({
  id: { type: "string" },
  regNo: { type: "string", example: "IHS-P-000179", description: "Display form of the real user id" },
  name: { type: "string" },
  phone: nstr,
  avatarUrl: nstr,
  age: { type: "integer", nullable: true },
  gender: nstr,
});
const WorkbenchVisit = obj({
  bookingId: { type: "string" },
  patient: PatientLite,
  date: { type: "string", format: "date" },
  startTime: { type: "string" },
  endTime: { type: "string" },
  appointmentType: { type: "string", enum: ["clinic", "video"], description: "In-clinic or video — the appointment type only" },
  status: { type: "string" },
  queueNumber: { type: "integer", nullable: true },
  queueState: nstr,
  clinic: { ...obj({ id: { type: "string" }, name: { type: "string" }, city: nstr }), nullable: true },
  isReferral: { type: "boolean" },
  canOpen: { type: "boolean", description: "false for an unpaid hold (record still locked)" },
});
const RosterEntry = obj({
  patient: PatientLite,
  visitCount: { type: "integer" },
  lastVisitOn: { type: "string", format: "date" },
  lastBookingId: { type: "string" },
});
const capped = (items) => obj({ rows: { type: "array", items }, capped: { type: "boolean" } });

const VitalEntry = obj({
  id: { type: "string" },
  recordedOn: { type: "string", format: "date" },
  recordedAt: { type: "string", format: "date-time", nullable: true },
  bookingId: nstr,
  source: { type: "string" },
  values: obj({
    weightKg: nnum, heightCm: nnum, bmi: nnum, waistCm: nnum, hipCm: nnum, waistHipRatio: nnum,
    temperatureF: nnum, spo2Percent: nnum, respiratoryRate: nnum, pulseRateBpm: nnum, heartRateBpm: nnum,
    bpSystolic: nnum, bpDiastolic: nnum, bloodPressure: nstr, headCircumferenceCm: nnum,
  }),
  statuses: { type: "object", description: "Per-value reference-range status (adults only)" },
});
const VitalsMatrix = obj({ fields: { type: "array", items: { type: "object" } }, entries: { type: "array", items: VitalEntry } });

const Entry = obj({
  id: { type: "string" },
  kind: { type: "string", enum: CLINICAL_ENTRY_KINDS },
  category: nstr,
  title: nstr,
  code: { ...nstr, description: "ICD code (diagnosis)" },
  details: { type: "object", nullable: true },
  remarks: nstr,
  recordedOn: nstr,
  patientVisible: { type: "boolean", description: "Doctor's note: published. Others: shown to the patient" },
  status: { type: "string", enum: Object.values(CLINICAL_ENTRY_STATUS) },
  retiredReason: nstr,
  bookingId: nstr,
  visitDate: nstr,
  author: { ...obj({ id: { type: "string" }, name: { type: "string" } }), nullable: true },
  isMine: { type: "boolean", description: "Doctor viewer only" },
  canEdit: { type: "boolean", description: "Doctor viewer only — same rule the server enforces" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
});
const EntryCreate = {
  type: "object",
  required: ["kind"],
  description: [
    "Per kind:",
    "complaint — title (+ details.duration/durationUnit/severity);",
    "history — category (history key) + details or remarks;",
    "comorbidity — category + title;",
    "examination — category (form key) + details (findings);",
    `diagnosis — title + category (${DIAGNOSIS_TYPES.join("/")}) (+ code, details.stage);`,
    `investigation — title + category (${INVESTIGATION_TYPES.join("/")}) + details.priority (${ORDER_PRIORITIES.join("/")}) (+ quantity, diagnosticTestId);`,
    `doctor_note — category (${DOCTOR_NOTE_TYPES.join("/")}) + remarks; private draft unless patientVisible=true.`,
  ].join(" "),
  properties: {
    kind: { type: "string", enum: CLINICAL_ENTRY_KINDS },
    category: { type: "string" },
    title: { type: "string" },
    code: { type: "string" },
    details: { type: "object" },
    remarks: { type: "string" },
    recordedOn: { type: "string", format: "date" },
    patientVisible: { type: "boolean" },
  },
};
const Visit = obj({
  bookingId: { type: "string" },
  date: { type: "string", format: "date" },
  startTime: { type: "string" },
  appointmentType: { type: "string", enum: ["clinic", "video"] },
  status: { type: "string" },
  clinic: { type: "object", nullable: true },
  doctor: { type: "object", nullable: true },
});
const Identity = obj({
  id: { type: "string" }, regNo: { type: "string" }, registeredAt: { type: "string", format: "date-time" },
  name: { type: "string" }, phone: nstr, email: nstr, avatarUrl: nstr, age: { type: "integer", nullable: true },
  dateOfBirth: nstr, gender: nstr, bloodGroup: { type: "string" }, address: nstr,
  emergencyContact: { type: "object", nullable: true },
  allergies: { type: "array", items: { type: "object" } },
  conditions: { type: "array", items: { type: "object" } },
  currentMedications: { type: "array", items: { type: "object" } },
});
const LatestVitals = { type: "object", description: "{ [field]: { value, recordedOn, recordedAt, status } } — newest non-null value of each vital" };
const VisitSummary = obj({
  visit: Visit,
  vitals: { type: "array", items: VitalEntry },
  prescription: { type: "object", nullable: true },
  entries: { type: "array", items: Entry },
  clinicalNotes: { type: "array", items: { type: "object" } },
  followUp: { type: "object", nullable: true },
});

const emrPaths = {
  "/doctor/emr/catalog": {
    get: { tags: [TAG], summary: "Form vocabulary (history categories, examination forms, priorities, units)", security: bearer, responses: { 200: ok("Catalogue", { type: "object" }), 401: denied[401] } },
  },
  "/doctor/emr/workbench": {
    get: {
      tags: [TAG],
      summary: "The doctor's workbench, built from real bookings",
      description: "consultations (selected date, pending or completed), today (every non-cancelled visit that date), upcoming (after that date), previous (patients with a completed consultation), all (every treated patient). Search matches name, mobile, registration number, patient id or visit id.",
      security: bearer,
      parameters: [
        query("date", { type: "string", format: "date" }, "Defaults to today (IST)"),
        query("view", { type: "string", enum: ["pending", "completed"] }),
        query("q", { type: "string" }, "Search text"),
      ],
      responses: {
        200: ok("Workbench", obj({
          date: { type: "string" }, view: { type: "string" },
          counts: obj({ pending: { type: "integer" }, completed: { type: "integer" } }),
          consultations: { type: "array", items: WorkbenchVisit },
          today: { type: "array", items: WorkbenchVisit },
          upcoming: capped(WorkbenchVisit),
          previous: capped(RosterEntry),
          all: capped(RosterEntry),
        })),
        401: denied[401],
        422: errorResponse("Invalid query"),
      },
    },
  },
  "/doctor/emr/search/medicines": {
    get: { tags: [TAG], summary: "Search the doctor's own medicines + the platform catalogue (active only)", security: bearer, parameters: [query("q", { type: "string", minLength: 2 })], responses: { 200: ok("Medicines", { type: "array", items: { type: "object" } }), 401: denied[401] } },
  },
  "/doctor/emr/search/investigations": {
    get: { tags: [TAG], summary: "Search tests the platform's diagnostic labs offer", security: bearer, parameters: [query("q", { type: "string", minLength: 2 })], responses: { 200: ok("Investigations", { type: "array", items: { type: "object" } }), 401: denied[401] } },
  },
  "/doctor/emr/search/diagnoses": {
    get: { tags: [TAG], summary: "Diagnoses this doctor has recorded before (suggestions)", security: bearer, parameters: [query("q", { type: "string", minLength: 2 })], responses: { 200: ok("Diagnoses", { type: "array", items: { type: "object" } }), 401: denied[401] } },
  },
  "/doctor/emr/patients/{patientId}": {
    get: {
      tags: [TAG],
      summary: "Patient workspace: identity, current visit, latest vitals, visit list (audited)",
      security: bearer,
      parameters: [pathParam("patientId"), query("bookingId", { type: "integer" }, "The visit to open; else today's, else the latest")],
      responses: { 200: ok("Workspace", obj({ patient: Identity, encounter: { ...Visit, nullable: true }, latestVitals: LatestVitals, vitalFields: { type: "array", items: { type: "object" } }, visits: { type: "array", items: Visit } })), ...denied },
    },
  },
  "/doctor/emr/patients/{patientId}/vitals": {
    get: {
      tags: [TAG], summary: "Full vitals history (list + graph data), newest first", security: bearer,
      parameters: [pathParam("patientId"), query("from", { type: "string", format: "date" }), query("to", { type: "string", format: "date" })],
      responses: { 200: ok("Vitals", VitalsMatrix), ...denied },
    },
  },
  "/doctor/emr/patients/{patientId}/entries": {
    get: {
      tags: [TAG], summary: "Structured entries (other doctors' unpublished notes are never returned)", security: bearer,
      parameters: [pathParam("patientId"), query("kind", { type: "string", enum: CLINICAL_ENTRY_KINDS }), query("bookingId", { type: "integer" }), query("includeRetired", { type: "boolean" })],
      responses: { 200: ok("Entries", { type: "array", items: Entry }), ...denied },
    },
  },
  "/doctor/emr/patients/{patientId}/documents": {
    get: {
      tags: [TAG],
      summary: "The patient's documents this doctor may see",
      description:
        "Treating doctors only. Each document is one the doctor filed (access.via=own), in a consent category the patient granted (via=category: prescriptions → medications, other documents → investigations), or shared individually through a document request (via=document — fileUrl is null; read it through /doctor/access-requests/{id}/records/{recordId}/file). Locked documents are absent; identity documents are never returned.",
      security: bearer,
      parameters: [pathParam("patientId")],
      responses: { 200: ok("Documents", { type: "array", items: { type: "object" } }), ...denied },
    },
  },
  "/doctor/emr/patients/{patientId}/visits/{bookingId}": {
    get: { tags: [TAG], summary: "Previous visit summary — everything recorded in one visit", security: bearer, parameters: [pathParam("patientId"), pathParam("bookingId")], responses: { 200: ok("Visit summary", VisitSummary), ...denied } },
  },
  "/doctor/emr/bookings/{bookingId}/vitals": {
    post: {
      tags: [TAG], summary: "Add a vitals reading to this visit (appends; never overwrites)", security: bearer,
      parameters: [pathParam("bookingId")],
      requestBody: { required: true, ...jsonBody(obj({ recordedAt: { type: "string", format: "date-time" }, bpSystolic: { type: "integer" }, bpDiastolic: { type: "integer" }, pulseRateBpm: { type: "integer" }, heartRateBpm: { type: "integer" }, respiratoryRate: { type: "integer" }, spo2Percent: { type: "integer" }, temperatureF: { type: "number" }, heightCm: { type: "number" }, weightKg: { type: "number" }, waistCm: { type: "number" }, hipCm: { type: "number" }, headCircumferenceCm: { type: "number" }, note: { type: "string" }, location: { type: "string" } })) },
      responses: { 201: ok("Vitals saved", VitalsMatrix), ...denied, 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/emr/bookings/{bookingId}/entries": {
    post: { tags: [TAG], summary: "Record a structured entry in this visit (audited)", security: bearer, parameters: [pathParam("bookingId")], requestBody: { required: true, ...jsonBody(EntryCreate) }, responses: { 201: ok("Saved", Entry), ...denied, 422: errorResponse("Validation failed") } },
  },
  "/doctor/emr/entries/{id}": {
    patch: {
      tags: [TAG], summary: "Correct an entry (author only, within 24 h; a published note is final). Send { patientVisible: true } to publish a draft note.", security: bearer,
      parameters: [pathParam("id")],
      requestBody: { required: true, ...jsonBody(obj({ title: { type: "string" }, code: { type: "string" }, details: { type: "object" }, remarks: { type: "string" }, recordedOn: { type: "string" }, patientVisible: { type: "boolean" } })) },
      responses: { 200: ok("Updated", Entry), ...denied, 409: errorResponse("Final — retire it and add a new entry") },
    },
  },
  "/doctor/emr/entries/{id}/retire": {
    post: { tags: [TAG], summary: "Mark an entry as entered in error (kept, never deleted)", security: bearer, parameters: [pathParam("id")], requestBody: { required: true, ...jsonBody(obj({ reason: { type: "string" } })) }, responses: { 200: ok("Retired", Entry), ...denied } },
  },
  "/patient/medical-profile": {
    get: {
      tags: [PTAG], summary: "The signed-in patient's own medical profile (patient-visible entries only)", security: bearer,
      responses: { 200: ok("Medical profile", obj({ patient: Identity, latestVitals: LatestVitals, vitals: VitalsMatrix, entries: { type: "array", items: Entry }, visits: { type: "array", items: Visit }, followUps: { type: "array", items: { type: "object" } } })), 401: denied[401], 403: denied[403] },
    },
  },
  "/patient/visits/{bookingId}/summary": {
    get: { tags: [PTAG], summary: "One of the patient's own visits — what was recorded (finalized prescription, published notes)", security: bearer, parameters: [pathParam("bookingId")], responses: { 200: ok("Visit summary", VisitSummary), 401: denied[401], 404: errorResponse("Visit not found") } },
  },
};

const emrTags = [
  { name: TAG, description: "Doctor workbench + patient medical workspace (migration 051)" },
  { name: PTAG, description: "The patient's own medical record" },
];

module.exports = { emrPaths, emrTags };
