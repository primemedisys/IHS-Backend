/**
 * OpenAPI paths for migration 059, merged into the spec by config/swagger.js:
 *   - the admin diagnosis / ICD code master (/admin/icd-codes…);
 *   - the doctor's ICD search (/doctor/emr/search/icd) and coded diagnoses
 *     (POST /doctor/emr/bookings/{id}/entries now accepts `icdCodeId`);
 *   - refreshing a prescription draft from its Patient Workbench consultation.
 */
const { ICD_CODING_SYSTEMS, ICD_IMPORT_MAX_ROWS } = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description, data) => ({ description, ...jsonBody(envelope(data)) });
const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "integer" } });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, description });
const obj = (properties) => ({ type: "object", properties });
const nstr = { type: "string", nullable: true };

const ATAG = "Admin ICD code master";
const DTAG = "Doctor EMR workspace";
const RTAG = "Prescriptions";
const SYSTEMS = ICD_CODING_SYSTEMS.map((s) => s.key);
const adminDenied = { 401: errorResponse("Not signed in"), 403: errorResponse("Admins only") };

const IcdCode = obj({
  id: { type: "string" },
  codingSystem: { type: "string", enum: SYSTEMS },
  systemVersion: { type: "string", example: "2019" },
  code: { type: "string", example: "M54.5" },
  title: { type: "string", example: "Low back pain" },
  description: nstr,
  category: nstr,
  isActive: { type: "boolean" },
  usedCount: { type: "integer", description: "Recorded diagnoses coded with this row (admin list only)" },
});

const IcdWrite = obj({
  codingSystem: { type: "string", enum: SYSTEMS },
  systemVersion: { type: "string" },
  code: { type: "string", description: "Letters, digits, '.' and '-'; stored upper-case" },
  title: { type: "string", description: "Diagnosis name doctors search" },
  description: { ...nstr, description: "Official description from the source classification" },
  category: nstr,
  isActive: { type: "boolean" },
});

const clinicalCodingPaths = {
  "/admin/icd-codes/meta": {
    get: {
      tags: [ATAG],
      summary: "Coding systems accepted, versions in use (with counts) and the catalogue doctors search",
      security: bearer,
      responses: { 200: ok("ICD catalogue", { type: "object" }), ...adminDenied },
    },
  },
  "/admin/icd-codes": {
    get: {
      tags: [ATAG],
      summary: "Search / filter the ICD master",
      security: bearer,
      parameters: [
        query("q", { type: "string" }, "Code prefix (with or without the dot), name, description or category"),
        query("codingSystem", { type: "string", enum: SYSTEMS }),
        query("systemVersion", { type: "string" }),
        query("status", { type: "string", enum: ["all", "active", "inactive"] }),
        query("page", { type: "integer" }),
        query("limit", { type: "integer", maximum: 100 }),
      ],
      responses: { 200: ok("ICD codes", obj({ rows: { type: "array", items: IcdCode }, total: { type: "integer" }, page: { type: "integer" }, limit: { type: "integer" } })), ...adminDenied },
    },
    post: {
      tags: [ATAG],
      summary: "Add one diagnosis + ICD code (duplicate code within the same system + version → 409 ICD_DUPLICATE)",
      security: bearer,
      requestBody: { required: true, ...jsonBody(IcdWrite) },
      responses: { 201: ok("Added", IcdCode), 409: errorResponse("ICD_DUPLICATE — details.id is the existing row"), 422: errorResponse("Validation failed"), ...adminDenied },
    },
  },
  "/admin/icd-codes/{id}": {
    patch: {
      tags: [ATAG],
      summary: "Edit, activate or deactivate a row (never deleted; recorded diagnoses keep their snapshot)",
      security: bearer,
      parameters: [pathParam("id")],
      requestBody: { required: true, ...jsonBody(IcdWrite) },
      responses: { 200: ok("Updated", IcdCode), 404: errorResponse("Not found"), 409: errorResponse("ICD_DUPLICATE"), ...adminDenied },
    },
  },
  "/admin/icd-codes/import": {
    post: {
      tags: [ATAG],
      summary: `Import rows of ONE verified catalogue (system + version), up to ${ICD_IMPORT_MAX_ROWS} per request. Add-only: existing codes are skipped, never overwritten.`,
      security: bearer,
      requestBody: {
        required: true,
        ...jsonBody(
          obj({
            codingSystem: { type: "string", enum: SYSTEMS },
            systemVersion: { type: "string" },
            dryRun: { type: "boolean", description: "Report the counts without writing" },
            rows: { type: "array", maxItems: ICD_IMPORT_MAX_ROWS, items: obj({ code: { type: "string" }, title: { type: "string" }, description: nstr, category: nstr }) },
          })
        ),
      },
      responses: {
        200: ok(
          "Import result",
          obj({
            received: { type: "integer" },
            inserted: { type: "integer" },
            wouldInsert: { type: "integer" },
            skippedExisting: { type: "array", items: { type: "string" } },
            duplicatesInFile: { type: "array", items: { type: "string" } },
          })
        ),
        422: errorResponse("A row failed validation"),
        ...adminDenied,
      },
    },
  },
  "/doctor/emr/search/icd": {
    get: {
      tags: [DTAG],
      summary: "Search the admin ICD catalogue by diagnosis name or code — returns every match for the doctor to choose; nothing is assigned automatically",
      security: bearer,
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 2 }, example: "low back pain" }],
      responses: { 200: ok("ICD codes", { type: "array", items: IcdCode }), 401: errorResponse("Not signed in"), 403: errorResponse("Doctors only") },
    },
  },
  "/doctor/prescriptions/{id}/sync-workbench": {
    post: {
      tags: [RTAG],
      summary:
        "Refill a DRAFT from its Patient Workbench consultation: chief complaint, diagnosis line (with ICD), vitals of this consultation and the follow-up date are copied; `clinicalSnapshot` holds the full Workbench record. The Workbench itself is only read. Finalize repeats this inside its transaction and freezes the snapshot.",
      security: bearer,
      parameters: [pathParam("id")],
      responses: {
        200: ok("Prescription (doctor view) with clinicalSnapshot", { type: "object" }),
        404: errorResponse("Not this doctor's prescription"),
        409: errorResponse("Finalized — amend it instead"),
      },
    },
  },
};

const clinicalCodingTags = [{ name: ATAG, description: "Admin-managed diagnosis / ICD catalogue (migration 059)" }];

module.exports = { clinicalCodingPaths, clinicalCodingTags };
