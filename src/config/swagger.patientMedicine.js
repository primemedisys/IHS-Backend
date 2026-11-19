/**
 * OpenAPI paths for the patient's My Medicines — routines, doses, reminder
 * settings (migration 055) — merged into the spec by config/swagger.js.
 * Full field reference: docs/medicine-management-31-10-2026/api.md.
 */
const {
  MEDICINE_TYPES,
  MEDICINE_TIMINGS,
  PATIENT_MEDICINE_STATUS,
  PATIENT_MEDICINE_SOURCES,
  DOSE_STATUS,
  DOSE_ACTIONS,
  DOSE_ACTION_SOURCES,
  DOSE_SNOOZE_MINUTES,
  MAX_MEDICINES_PER_REQUEST,
  MAX_REMINDER_TIMES,
} = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description, data) => ({ description, ...jsonBody(envelope(data)) });
const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "string", pattern: "^\\d+$" } });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, description });
const nstr = { type: "string", nullable: true };
const obj = (properties) => ({ type: "object", properties });
const TAG = "Patient medicines";

const denied = { 401: errorResponse("Not signed in"), 403: errorResponse("Not a patient") };
const times = { type: "array", maxItems: MAX_REMINDER_TIMES, items: { type: "string", example: "08:00" } };
const days = { type: "array", nullable: true, items: { type: "integer", minimum: 0, maximum: 6 }, description: "null = every day; 0 = Sunday" };

const Routine = obj({
  id: { type: "string" },
  source: { type: "string", enum: Object.values(PATIENT_MEDICINE_SOURCES) },
  verified: { type: "boolean", description: "true only for a doctor's finalized prescription" },
  prescriptionId: nstr,
  prescription: { type: "object", nullable: true },
  prescriber: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" } } },
  medicineMasterId: nstr,
  medicineName: { type: "string" },
  genericName: nstr,
  strength: nstr,
  dosageForm: { type: "string", nullable: true, enum: [...MEDICINE_TYPES, null] },
  dose: nstr,
  frequency: nstr,
  foodTiming: { type: "string", nullable: true, enum: [...MEDICINE_TIMINGS, null] },
  reminderTimes: times,
  daysOfWeek: days,
  timezone: { type: "string", example: "Asia/Kolkata" },
  startDate: { type: "string", format: "date" },
  durationDays: { type: "integer", nullable: true },
  endDate: { type: "string", format: "date", nullable: true },
  instructions: nstr,
  prescribed: { type: "object", nullable: true, description: "The doctor's original line, frozen" },
  reminderEnabled: { type: "boolean" },
  status: { type: "string", enum: Object.values(PATIENT_MEDICINE_STATUS) },
  statusReason: nstr,
  needsSetup: { type: "boolean" },
  suggestedReminderCount: { type: "integer", nullable: true },
});

const Dose = obj({
  id: { type: "string" },
  patientMedicineId: { type: "string" },
  scheduledDate: { type: "string", format: "date" },
  scheduledTime: { type: "string", example: "20:00" },
  scheduledAt: { type: "string", format: "date-time" },
  dueAt: { type: "string", format: "date-time" },
  status: { type: "string", enum: Object.values(DOSE_STATUS) },
  snoozeCount: { type: "integer" },
  actionAt: { type: "string", format: "date-time", nullable: true },
  actionSource: nstr,
  medicine: { type: "object" },
});

const Settings = obj({
  privacyMode: { type: "boolean" },
  webReminders: { type: "boolean" },
  defaultSnoozeMinutes: { type: "integer", enum: DOSE_SNOOZE_MINUTES },
  timezone: { type: "string" },
  snoozeOptions: { type: "array", items: { type: "integer" } },
});

const NewItem = obj({
  clientRequestId: { type: "string", maxLength: 64, description: "Retry key — the same id returns the same row" },
  medicineMasterId: { type: "string", description: "Picked from /search; otherwise medicineName is required" },
  medicineName: { type: "string" },
  genericName: nstr,
  strength: nstr,
  dosageForm: { type: "string", enum: MEDICINE_TYPES },
  dose: nstr,
  frequency: nstr,
  foodTiming: { type: "string", enum: MEDICINE_TIMINGS },
  reminderTimes: times,
  daysOfWeek: days,
  startDate: { type: "string", format: "date" },
  durationDays: { type: "integer", nullable: true, minimum: 1, maximum: 3650 },
  instructions: nstr,
  reminderEnabled: { type: "boolean" },
});

const patientMedicinePaths = {
  "/patient/medicines": {
    get: {
      tags: [TAG],
      summary: "My medicines (routines)",
      security: bearer,
      parameters: [
        query("status", { type: "string", enum: Object.values(PATIENT_MEDICINE_STATUS) }),
        query("source", { type: "string", enum: Object.values(PATIENT_MEDICINE_SOURCES) }),
      ],
      responses: { 200: ok("Routines", { type: "array", items: Routine }), ...denied },
    },
    post: {
      tags: [TAG],
      summary: `Add 1–${MAX_MEDICINES_PER_REQUEST} of my own medicines in one transaction`,
      description: "Each item has its own schedule. Patient entries are private and never added to the shared catalogue.",
      security: bearer,
      requestBody: {
        required: true,
        ...jsonBody(obj({ timezone: { type: "string" }, items: { type: "array", items: NewItem, minItems: 1, maxItems: MAX_MEDICINES_PER_REQUEST } })),
      },
      responses: { 201: ok("Saved", { type: "array", items: Routine }), 404: errorResponse("Catalogue medicine not found"), 422: errorResponse("Validation failed"), ...denied },
    },
  },
  "/patient/medicines/search": {
    get: {
      tags: [TAG],
      summary: "Search the shared medicine catalogue",
      security: bearer,
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 2 } }],
      responses: { 200: ok("Catalogue hits", { type: "array", items: { type: "object" } }), ...denied },
    },
  },
  "/patient/medicines/summary": {
    get: {
      tags: [TAG],
      summary: "Dashboard: today's doses, next dose, routines, adherence (from dose rows)",
      security: bearer,
      responses: { 200: ok("Summary", { type: "object" }), ...denied },
    },
  },
  "/patient/medicines/doses": {
    get: {
      tags: [TAG],
      summary: "Dose occurrences in a range (default: my local today; max 8 days)",
      security: bearer,
      parameters: [query("from", { type: "string", format: "date-time" }), query("to", { type: "string", format: "date-time" })],
      responses: { 200: ok("Doses", { type: "array", items: Dose }), 422: errorResponse("Bad range"), ...denied },
    },
  },
  "/patient/medicines/doses/history": {
    get: {
      tags: [TAG],
      summary: "Past doses, newest first",
      security: bearer,
      parameters: [
        query("page", { type: "integer", minimum: 1 }),
        query("limit", { type: "integer", minimum: 1, maximum: 100 }),
        query("patientMedicineId", { type: "string" }),
        query("status", { type: "string", enum: Object.values(DOSE_STATUS) }),
      ],
      responses: { 200: ok("History page", { type: "object" }), ...denied },
    },
  },
  "/patient/medicines/doses/{doseId}/action": {
    post: {
      tags: [TAG],
      summary: "Taken / Skip / Snooze one dose (idempotent)",
      security: bearer,
      parameters: [pathParam("doseId")],
      requestBody: {
        required: true,
        ...jsonBody(
          obj({
            action: { type: "string", enum: Object.values(DOSE_ACTIONS) },
            snoozeMinutes: { type: "integer", enum: DOSE_SNOOZE_MINUTES },
            source: { type: "string", enum: DOSE_ACTION_SOURCES },
            actedAt: { type: "string", format: "date-time" },
          })
        ),
      },
      responses: {
        200: ok("Dose (changed=false when it was already recorded)", obj({ dose: Dose, changed: { type: "boolean" } })),
        404: errorResponse("Dose not found"),
        409: errorResponse("DOSE_ALREADY_TAKEN / DOSE_NOT_ACTIONABLE"),
        ...denied,
      },
    },
  },
  "/patient/medicines/settings": {
    get: { tags: [TAG], summary: "Reminder settings", security: bearer, responses: { 200: ok("Settings", Settings), ...denied } },
    put: {
      tags: [TAG],
      summary: "Update reminder settings (privacy mode, website reminders, snooze, time zone)",
      security: bearer,
      requestBody: { required: true, ...jsonBody(Settings) },
      responses: { 200: ok("Settings", Settings), 422: errorResponse("Validation failed"), ...denied },
    },
  },
  "/patient/medicines/{id}": {
    get: {
      tags: [TAG],
      summary: "One routine + recent doses",
      security: bearer,
      parameters: [pathParam("id")],
      responses: { 200: ok("Routine", Routine), 404: errorResponse("Not found"), ...denied },
    },
    patch: {
      tags: [TAG],
      summary: "Edit a routine (prescribed routines: reminder fields only)",
      security: bearer,
      parameters: [pathParam("id")],
      requestBody: { required: true, ...jsonBody(NewItem) },
      responses: {
        200: ok("Routine", Routine),
        404: errorResponse("Not found"),
        409: errorResponse("PRESCRIBED_FIELD_LOCKED / PATIENT_MEDICINE_NOT_EDITABLE"),
        ...denied,
      },
    },
  },
  "/patient/medicines/{id}/status": {
    put: {
      tags: [TAG],
      summary: "Pause / resume / stop",
      security: bearer,
      parameters: [pathParam("id")],
      requestBody: { required: true, ...jsonBody(obj({ status: { type: "string", enum: ["active", "paused", "cancelled"] } })) },
      responses: { 200: ok("Routine", Routine), 404: errorResponse("Not found"), 409: errorResponse("Routine already ended"), ...denied },
    },
  },
};

// ── Doctor's own medicine list (existing endpoints, documented here) ────────
const DTAG = "Doctor medicines";
const DoctorMedicine = obj({
  id: { type: "string" },
  doctorId: { type: "string" },
  medicineMasterId: { ...nstr, description: "The shared catalogue row it is linked to (migration 055)" },
  name: { type: "string" },
  genericName: nstr,
  manufacturer: nstr,
  description: nstr,
  strength: { ...nstr, example: "500 mg" },
  dosageForm: { type: "string", nullable: true, enum: [...MEDICINE_TYPES, null] },
  form: { type: "string", description: "Legacy route (oral / topical / …)" },
  defaultFrequency: nstr,
  defaultTiming: { type: "string", nullable: true, enum: [...MEDICINE_TIMINGS, null] },
  category: nstr,
  isActive: { type: "boolean" },
});
const DoctorMedicineInput = obj({
  name: { type: "string" },
  genericName: nstr,
  manufacturer: nstr,
  description: nstr,
  medicineMasterId: { ...nstr, description: "Catalogue row picked from the search; else linked by NAME|STRENGTH|FORM" },
  strength: nstr,
  dosageForm: { type: "string", enum: MEDICINE_TYPES },
  defaultFrequency: nstr,
  defaultTiming: { type: "string", enum: MEDICINE_TIMINGS },
});
const docDenied = { 401: errorResponse("Not signed in"), 403: errorResponse("Not a doctor") };
const doctorMedicinePaths = {
  "/doctor/medicines": {
    get: {
      tags: [DTAG],
      summary: "My active medicines",
      security: bearer,
      parameters: [query("search", { type: "string" })],
      responses: { 200: ok("Medicines", { type: "array", items: DoctorMedicine }), ...docDenied },
    },
    post: {
      tags: [DTAG],
      summary: "Add a medicine (linked to the shared catalogue when a dosage form is given; no admin approval)",
      security: bearer,
      requestBody: { required: true, ...jsonBody(DoctorMedicineInput) },
      responses: {
        201: ok("Created", DoctorMedicine),
        409: errorResponse("MEDICINE_DUPLICATE — details.medicineId is the existing one"),
        422: errorResponse("Validation failed"),
        ...docDenied,
      },
    },
  },
  "/doctor/medicines/all": {
    get: { tags: [DTAG], summary: "All my medicines incl. hidden", security: bearer, responses: { 200: ok("Medicines", { type: "array", items: DoctorMedicine }), ...docDenied } },
  },
  "/doctor/medicines/{id}": {
    get: { tags: [DTAG], summary: "One medicine", security: bearer, parameters: [pathParam("id")], responses: { 200: ok("Medicine", DoctorMedicine), 404: errorResponse("Not found"), ...docDenied } },
    patch: {
      tags: [DTAG],
      summary: "Edit a medicine",
      security: bearer,
      parameters: [pathParam("id")],
      requestBody: { required: true, ...jsonBody({ ...DoctorMedicineInput, properties: { ...DoctorMedicineInput.properties, isActive: { type: "boolean" } } }) },
      responses: { 200: ok("Medicine", DoctorMedicine), 404: errorResponse("Not found"), 409: errorResponse("MEDICINE_DUPLICATE"), ...docDenied },
    },
    delete: { tags: [DTAG], summary: "Hide (soft-delete) a medicine", security: bearer, parameters: [pathParam("id")], responses: { 200: ok("Hidden", obj({ id: { type: "string" } })), ...docDenied } },
  },
};
Object.assign(patientMedicinePaths, doctorMedicinePaths);

const patientMedicineTags = [
  { name: TAG, description: "The patient's medicine routines, dose tracking and reminder settings (migration 055)" },
  { name: DTAG, description: "The doctor's own medicine list, linked to the shared IHS catalogue" },
];

module.exports = { patientMedicinePaths, patientMedicineTags };
