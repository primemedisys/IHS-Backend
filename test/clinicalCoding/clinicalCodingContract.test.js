/**
 * Migration 059 — DB-free contract tests: the ICD master's request contract,
 * code normalization and ranking, the Workbench → prescription snapshot (what
 * is printed and what is not), the shared-catalogue strength rule, the
 * serializers, and that the boot guard parses every ALTER out of the
 * migration (so the two can never drift).
 *
 *   node --test test/clinicalCoding/clinicalCodingContract.test.js
 */
require("../testEnv");
const test = require("node:test");
const assert = require("node:assert/strict");

const icdV = require("../../src/validators/icdCode.validator");
const emrV = require("../../src/validators/emr.validator");
const icd = require("../../src/services/icdCode.service");
const S = require("../../src/utils/serializers");
const ensure = require("../../src/db/ensureClinicalCoding");
const { compactStrength } = require("../../src/services/doctorMedicine.service");
const { ICD_IMPORT_MAX_ROWS, EXAMINATION_FORMS } = require("../../src/config/constants");

const run = (schema, value) => schema.validate(value, { abortEarly: false, stripUnknown: true, convert: true });

// ── ICD master contract ─────────────────────────────────────────────────────
test("icd: a code needs an explicit system + version; systems are not interchangeable", () => {
  const ok = { codingSystem: "ICD-10", systemVersion: "2019", code: "M54.5", title: "Low back pain" };
  assert.equal(run(icdV.create, ok).error, undefined);
  assert.ok(run(icdV.create, { ...ok, codingSystem: undefined }).error, "system required");
  assert.ok(run(icdV.create, { ...ok, systemVersion: undefined }).error, "version required");
  assert.ok(run(icdV.create, { ...ok, codingSystem: "ICD-9" }).error, "unknown system rejected");
  assert.ok(run(icdV.create, { ...ok, code: "M54.5; DROP" }).error, "code pattern");
  assert.ok(run(icdV.create, { ...ok, title: "x" }).error, "name too short");
  assert.ok(run(icdV.update, {}).error, "an edit changes something");
  assert.equal(run(icdV.update, { isActive: false }).error, undefined, "deactivate is an edit");
});

test("icd: import is bounded and every row is validated", () => {
  const row = { code: "M54.5", title: "Low back pain" };
  const body = (rows) => ({ codingSystem: "ICD-11", systemVersion: "2024-01", rows });
  assert.equal(run(icdV.importBody, body([row])).error, undefined);
  assert.equal(run(icdV.importBody, body([row])).value.dryRun, false, "writes only when asked");
  assert.ok(run(icdV.importBody, body([])).error, "empty file rejected");
  assert.ok(run(icdV.importBody, body([{ code: "bad code!", title: "X y" }])).error, "bad row rejected");
  assert.ok(run(icdV.importBody, body(Array.from({ length: ICD_IMPORT_MAX_ROWS + 1 }, () => row))).error, "chunk limit");
});

test("icd: codes normalize; search ranks exact code, code prefix, exact name, name prefix", () => {
  assert.equal(icd.normCode(" m54.5 "), "M54.5");
  assert.equal(icd.dotless("M54.5"), "M545");
  const rows = [
    { code: "M54.4", title: "Lumbago with sciatica" },
    { code: "M54.5", title: "Low back pain" },
    { code: "M54", title: "Dorsalgia" },
  ];
  assert.equal(icd.rank(rows[1], "m545"), 0, "dotless exact code");
  assert.equal(icd.rank(rows[0], "M54"), 1, "code prefix");
  assert.equal(icd.rank(rows[1], "low back pain"), 2, "exact name");
  assert.equal(icd.rank(rows[1], "low back"), 3, "name prefix");
  assert.equal(icd.rank(rows[0], "sciatica"), 4);
});

test("entries: only a diagnosis may carry icdCodeId", () => {
  assert.equal(run(emrV.createEntry, { kind: "diagnosis", title: "Low back pain", category: "final", icdCodeId: "7" }).error, undefined);
  assert.ok(run(emrV.createEntry, { kind: "complaint", title: "Back pain", icdCodeId: "7" }).error);
  assert.equal(run(emrV.updateEntry, { icdCodeId: "7", remarks: "x" }).value.icdCodeId, undefined, "a correction cannot re-point the catalogue link");
});

// ── Shared medicine catalogue ───────────────────────────────────────────────
test("catalogue: strength spacing/case is ignored, a different strength never matches", () => {
  assert.equal(compactStrength("100 mg"), compactStrength("100MG"));
  assert.equal(compactStrength(" 100  mg "), "100MG");
  assert.notEqual(compactStrength("100 mg"), compactStrength("200 mg"));
});

// ── Workbench → prescription snapshot ───────────────────────────────────────
const booking = {
  id: 41,
  slotDate: "2026-11-04",
  slotStartTime: "10:30:00",
  bookingType: "offline",
  status: "confirmed",
  clinic: { id: 2, name: "Sunrise Clinic", city: "Bhubaneswar" },
  doctor: { userId: 9, qualification: "MBBS", user: { name: "Dr. A" }, specializations: [{ name: "Orthopaedics" }] },
};
const patient = {
  id: 77,
  name: "Pat",
  phone: "9000000000",
  patientProfile: { dateOfBirth: "1990-01-15", gender: "female", bloodGroup: "B+", addressLine: "1 Main Rd", city: "Cuttack" },
};
const entries = [
  { id: 1, kind: "complaint", title: "Low back pain", details: { duration: 3, durationUnit: "day", severity: "moderate" }, patientVisible: true },
  { id: 2, kind: "examination", category: EXAMINATION_FORMS[0].key, details: { [EXAMINATION_FORMS[0].fields?.[0]?.key ?? "findings"]: "Tender L4-L5" }, patientVisible: true },
  { id: 3, kind: "diagnosis", title: "Low back pain", code: "M54.5", icdCodeId: 5, codeSystem: "ICD-10", codeVersion: "2019", category: "provisional", details: { stage: null }, patientVisible: true },
  { id: 4, kind: "diagnosis", title: "Private differential", code: null, category: "differential", patientVisible: false },
];
const reading = { recordedOn: "2026-11-04", recordedAt: "2026-11-04T05:10:00.000Z", bpSystolic: 128, bpDiastolic: 82, pulseRateBpm: 76, heartRateBpm: 78, respiratoryRate: 16, spo2Percent: 98, temperatureF: "98.4", heightCm: "160.0", weightKg: "64.0" };

test("snapshot: patient, consultation and clinical information come from the record", () => {
  const s = S.buildWorkbenchSnapshot({ booking, patient, entries, vitalRows: [reading], vitalSource: "consultation", followUp: { followUpOn: "2026-11-18" }, examForms: EXAMINATION_FORMS });
  assert.equal(s.patient.regNo, "IHS-P-000077");
  assert.equal(s.patient.bloodGroup, "B+");
  assert.equal(s.consultation.bookingId, "41");
  assert.equal(s.consultation.appointmentType, "clinic");
  assert.deepEqual(s.consultation.doctor.specializations, ["Orthopaedics"]);
  assert.equal(s.vitals.values.bloodPressure, "128/82");
  assert.equal(s.vitals.values.bmi, 25, "BMI derived, not stored");
  assert.equal(s.examinations[0].findings[0].value, "Tender L4-L5");
  assert.equal(s.printed.chiefComplaint, "1. Low back pain — since 3 days, moderate");
  assert.equal(s.printed.diagnosis, "1. Low back pain (ICD-10 M54.5) — provisional");
  assert.ok(!s.printed.diagnosis.includes("Private"), "a diagnosis not shown to the patient is never printed");
  assert.equal(s.diagnoses.length, 2, "…but the doctor still sees it");
  assert.equal(s.printed.vitals.bloodPressure, "128/82");
  assert.equal(s.printed.followUpDate, "2026-11-18");
});

test("snapshot: an older reading is shown with its date but never printed as today's", () => {
  const old = { ...reading, recordedOn: "2026-10-01", recordedAt: "2026-10-01T05:00:00.000Z" };
  const s = S.buildWorkbenchSnapshot({ booking, patient, entries: [], vitalRows: [old], vitalSource: "earlier" });
  assert.equal(s.vitals.source, "earlier");
  assert.equal(s.vitals.recordedOn, "2026-10-01");
  assert.equal(s.vitals.printable, false);
  assert.equal(s.printed.vitals, null);
  assert.equal(s.printed.chiefComplaint, null, "nothing in the Workbench → the prescription keeps its own value");
  assert.equal(s.printed.diagnosis, null);
});

test("snapshot: several readings of the visit merge newest-first, never invented", () => {
  const s = S.buildWorkbenchSnapshot({
    booking,
    patient,
    entries: [],
    vitalRows: [{ recordedOn: "2026-11-04", weightKg: "70.0" }, { recordedOn: "2026-11-04", weightKg: "71.0", bloodPressure: "120/80" }],
    vitalSource: "consultation",
  });
  assert.equal(s.vitals.values.weightKg, 70);
  assert.equal(s.vitals.values.bloodPressure, "120/80");
  assert.equal(s.vitals.values.temperatureF, null);
  assert.equal(s.vitals.values.bmi, null, "no height → no BMI");
});

test("snapshot v2: investigations, history, published advice and follow-up instructions", () => {
  const { HISTORY_CATEGORIES, COMORBIDITY_CATEGORIES } = require("../../src/config/constants");
  const more = [
    { id: 10, kind: "investigation", title: "CBC", category: "laboratory", details: { priority: "urgent", quantity: 1 }, remarks: "fasting sample", patientVisible: true },
    { id: 11, kind: "investigation", title: "X-ray LS spine", category: "radiology", details: { priority: "routine", quantity: 2 }, patientVisible: true },
    { id: 12, kind: "investigation", title: "Hidden test", category: "other", details: {}, patientVisible: false },
    { id: 13, kind: "history", category: "family", remarks: "Father diabetic", patientVisible: true },
    { id: 14, kind: "comorbidity", category: "hypertension", title: "Essential hypertension", recordedOn: "2020-01-01", patientVisible: true },
    { id: 15, kind: "doctor_note", category: "counselling", remarks: "Avoid heavy lifting", patientVisible: true },
    // gather() never passes a private note; even if one slipped in it must not print.
    { id: 16, kind: "doctor_note", category: "progress", remarks: "Private: suspect malingering", patientVisible: false },
  ];
  const s = S.buildWorkbenchSnapshot({
    booking,
    patient,
    entries: [...entries, ...more],
    vitalRows: [reading],
    vitalSource: "consultation",
    followUp: { followUpOn: "2026-11-18", note: "Bring X-ray report" },
    examForms: EXAMINATION_FORMS,
    historyCategories: HISTORY_CATEGORIES,
    comorbidityCategories: COMORBIDITY_CATEGORIES,
  });
  assert.equal(s.version, 2);
  assert.deepEqual(s.printed.investigations, ["CBC — URGENT — fasting sample", "X-ray LS spine — ×2"]);
  assert.equal(s.investigations.length, 3, "the doctor still sees a test not shown to the patient");
  assert.equal(s.history[0].label, "Family history");
  assert.equal(s.comorbidities[0].category, "Hypertension");
  assert.equal(s.printed.advice, "1. Avoid heavy lifting");
  assert.ok(!JSON.stringify(s).includes("malingering"), "a private note never enters the snapshot");
  assert.equal(s.printed.followUpNote, "Bring X-ray report");
});

test("snapshot v2: no published note → no advice, so the draft keeps its own", () => {
  const s = S.buildWorkbenchSnapshot({ booking, patient, entries, vitalRows: [], vitalSource: "none" });
  assert.equal(s.printed.advice, null);
  assert.deepEqual(s.printed.investigations, []);
  assert.equal(s.printed.followUpNote, null);
});

test("pdf view: investigations and follow-up instructions come from the frozen snapshot", () => {
  const { buildRenderView } = require("../../src/services/prescription.service");
  const v = buildRenderView({ items: [], clinicalSnapshot: { printed: { investigations: ["CBC"], followUpNote: "Fasting" } } });
  assert.deepEqual(v.investigations, ["CBC"]);
  assert.equal(v.followUpNote, "Fasting");
  const old = buildRenderView({ items: [], clinicalSnapshot: { version: 1, printed: {} } });
  assert.deepEqual(old.investigations, [], "a version-1 snapshot prints exactly as before");
  assert.equal(old.followUpNote, null);
});

// ── Serializers ─────────────────────────────────────────────────────────────
test("serializers: coded diagnosis fields on every entry; doctor Rx carries the snapshot", () => {
  const e = S.serializeClinicalEntry({ id: 1, kind: "diagnosis", title: "Low back pain", code: "M54.5", icdCodeId: 5, codeSystem: "ICD-10", codeVersion: "2019", codeDescription: "Low back pain", status: "active", patientVisible: true });
  assert.equal(e.icdCodeId, "5");
  assert.equal(e.codeSystem, "ICD-10");
  assert.equal(e.codeVersion, "2019");
  const free = S.serializeClinicalEntry({ id: 2, kind: "diagnosis", title: "x", code: "Z00", status: "active", patientVisible: true });
  assert.equal(free.icdCodeId, null);

  const rx = S.serializePrescriptionForDoctor({ id: 3, status: "draft", version: 1, patient: { id: 77, patientProfile: {} }, items: [], clinicalSnapshot: { version: 1 } });
  assert.equal(rx.patient.regNo, "IHS-P-000077");
  assert.deepEqual(rx.clinicalSnapshot, { version: 1 });
  const row = S.serializeIcdCode({ id: 9, codingSystem: "ICD-11", systemVersion: "2024-01", code: "ME84.2", title: "Low back pain", isActive: true });
  assert.equal(row.code, "ME84.2");
  assert.equal(row.usedCount, undefined, "usage only on the admin list");
});

// ── Boot guard ↔ migration ──────────────────────────────────────────────────
test("guard: parses the CREATE and every ALTER out of migration 059", () => {
  const creates = ensure.createStatements();
  assert.equal(creates.length, 1);
  assert.match(creates[0], /CREATE TABLE IF NOT EXISTS icd_codes/);
  assert.match(creates[0], /UNIQUE KEY uq_icd_system_code \(coding_system, system_version, code\)/);
  const alters = ensure.alterations();
  const cols = alters.filter((a) => a.column).map((a) => `${a.table}.${a.column}`);
  assert.deepEqual(cols, [
    "clinical_entries.icd_code_id",
    "clinical_entries.code_system",
    "clinical_entries.code_version",
    "clinical_entries.code_description",
    "prescriptions.clinical_snapshot",
  ]);
  assert.ok(alters.some((a) => a.index === "idx_ce_icd"));
  assert.ok(alters.some((a) => a.constraint === "fk_ce_icd"));
  for (const a of alters) assert.ok(/NULL|INDEX|FOREIGN KEY/.test(a.ddl), `additive only: ${a.ddl}`);
});
