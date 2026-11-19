/**
 * Doctor EMR workspace + the patient's own medical profile (migration 051).
 * Thin wrappers: validated input → one service call → serializer → envelope.
 */
const emr = require("../services/emr.service");
const timeline = require("../services/patientTimeline.service");
const clinicalAccess = require("../services/clinicalAccess.service");
const icd = require("../services/icdCode.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeWorkbench,
  serializeClinicalEntry,
  serializeEmrWorkspace,
  serializeVisitSummary,
  serializeEmrCatalog,
  serializeMedicineSearch,
  serializeInvestigationSearch,
  serializeMedicalProfile,
  serializeMedicalHistory,
  serializeClinicalAccess,
  serializeDoctorDocument,
  serializePatientVitals,
  serializeIcdCode,
  VITALS_EMR_FIELDS,
} = require("../utils/serializers");

const ctx = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });
const asDoctor = (req) => ({ viewerId: req.doctorId, canEdit: emr.canEditEntry });
const vitalsOut = ({ rows, age }) => serializePatientVitals(rows, { age, fields: VITALS_EMR_FIELDS });

// ── Doctor ───────────────────────────────────────────────────────────────────
exports.catalog = asyncHandler(async (_req, res) => ok(res, serializeEmrCatalog(), "EMR catalogue"));

exports.workbench = asyncHandler(async (req, res) =>
  ok(res, serializeWorkbench(await emr.workbench(req.doctorId, req.validatedQuery)), "Workbench")
);

exports.patient = asyncHandler(async (req, res) => {
  const result = await emr.patientWorkspace(req.doctorId, req.params.patientId, req.validatedQuery, ctx(req));
  return ok(res, serializeEmrWorkspace(result, { age: result.age }), "Patient workspace");
});

exports.vitals = asyncHandler(async (req, res) =>
  ok(res, vitalsOut(await emr.vitalsHistory(req.doctorId, req.params.patientId, req.validatedQuery)), "Vitals")
);

exports.addVitals = asyncHandler(async (req, res) =>
  created(res, vitalsOut(await emr.addVitals(req.doctorId, req.params.bookingId, req.body, ctx(req))), "Vitals saved")
);

exports.entries = asyncHandler(async (req, res) => {
  const rows = await emr.listEntries(req.doctorId, req.params.patientId, req.validatedQuery);
  return ok(res, rows.map((e) => serializeClinicalEntry(e, asDoctor(req))), "Clinical entries");
});

exports.createEntry = asyncHandler(async (req, res) => {
  const entry = await emr.createEntry(req.doctorId, req.params.bookingId, req.body, ctx(req));
  return created(res, serializeClinicalEntry(entry, asDoctor(req)), "Saved");
});

exports.updateEntry = asyncHandler(async (req, res) => {
  const entry = await emr.updateEntry(req.doctorId, req.params.id, req.body, ctx(req));
  return ok(res, serializeClinicalEntry(entry, asDoctor(req)), "Updated");
});

exports.retireEntry = asyncHandler(async (req, res) => {
  const entry = await emr.retireEntry(req.doctorId, req.params.id, req.body.reason, ctx(req));
  return ok(res, serializeClinicalEntry(entry, asDoctor(req)), "Marked as entered in error");
});

exports.visitSummary = asyncHandler(async (req, res) => {
  const result = await emr.visitSummaryForDoctor(req.doctorId, req.params.patientId, req.params.bookingId);
  const viewer = { role: "doctor", id: req.doctorId };
  return ok(res, serializeVisitSummary(result, { viewer, age: result.age, canEdit: emr.canEditEntry }), "Visit summary");
});

// ── Structured history + clinical-history consent (migration 057) ─────────────
exports.history = asyncHandler(async (req, res) => {
  const { history, access, age } = await emr.historyForDoctor(req.doctorId, req.params.patientId, ctx(req));
  return ok(res, serializeMedicalHistory(history, { viewerId: req.doctorId, age, access }), "Medical history");
});

/**
 * The patient's documents this doctor may see (own uploads, consented
 * categories, document-level shares). Locked ones are simply absent.
 */
exports.documents = asyncHandler(async (req, res) => {
  const docs = await emr.documentsForDoctor(req.doctorId, req.params.patientId, ctx(req));
  return ok(
    res,
    docs.map((d) =>
      // A document-level share is streamed through its audited endpoint — no link.
      serializeDoctorDocument(d.row, { access: d.access, ...(d.streamOnly ? { fileUrl: null } : {}) })
    ),
    "Patient documents"
  );
});

/**
 * The patient's longitudinal timeline (server-side filter / sort / pagination).
 * Built from the SAME consent-filtered history and documents the other
 * endpoints return, so it can never include a record the doctor cannot open.
 */
exports.timeline = asyncHandler(async (req, res) => {
  const { history, access, age } = await emr.historyForDoctor(req.doctorId, req.params.patientId, ctx(req));
  const docs = await emr.documentsForDoctor(req.doctorId, req.params.patientId, ctx(req));
  const h = serializeMedicalHistory(history, { viewerId: req.doctorId, age, access });
  const d = docs.map((x) => serializeDoctorDocument(x.row, { access: x.access, ...(x.streamOnly ? { fileUrl: null } : {}) }));
  return ok(res, timeline.build(h, d, req.validatedQuery), "Patient timeline");
});

exports.audit = asyncHandler(async (req, res) =>
  ok(res, await emr.auditForDoctor(req.doctorId, req.params.patientId, req.validatedQuery), "Audit history")
);

exports.access = asyncHandler(async (req, res) =>
  ok(res, serializeClinicalAccess(await clinicalAccess.summaryForDoctor(req.doctorId, req.params.patientId)), "Record access")
);

exports.requestAccess = asyncHandler(async (req, res) =>
  created(
    res,
    serializeClinicalAccess(await clinicalAccess.requestAccess(req.doctorId, req.params.patientId, req.body, ctx(req))),
    "Request sent to the patient"
  )
);

exports.searchMedicines = asyncHandler(async (req, res) =>
  ok(res, serializeMedicineSearch(await emr.searchMedicines(req.doctorId, req.validatedQuery.q)), "Medicines")
);

exports.searchInvestigations = asyncHandler(async (req, res) =>
  ok(res, serializeInvestigationSearch(await emr.searchInvestigations(req.validatedQuery.q)), "Investigations")
);

exports.diagnosisSuggestions = asyncHandler(async (req, res) =>
  ok(res, await emr.diagnosisSuggestions(req.doctorId, req.validatedQuery.q), "Diagnoses")
);

/** The admin ICD catalogue (migration 059) — matches for the doctor to choose from. */
exports.searchIcd = asyncHandler(async (req, res) =>
  ok(res, (await icd.search(req.validatedQuery.q)).map((r) => serializeIcdCode(r)), "ICD codes")
);

// ── Patient (their own record only — req.user.id, never a client-sent id) ─────
exports.myMedicalProfile = asyncHandler(async (req, res) => {
  const result = await emr.medicalProfileForPatient(req.user.id);
  return ok(res, serializeMedicalProfile(result, { age: result.age }), "Medical profile");
});

exports.myMedicalHistory = asyncHandler(async (req, res) => {
  const { history, age } = await emr.historyForPatient(req.user.id);
  return ok(res, serializeMedicalHistory(history, { age }), "Medical history");
});

exports.myVisitSummary = asyncHandler(async (req, res) => {
  const result = await emr.visitSummaryForPatient(req.user.id, req.params.bookingId);
  return ok(res, serializeVisitSummary(result, { viewer: { role: "patient", id: req.user.id }, age: result.age }), "Visit summary");
});
