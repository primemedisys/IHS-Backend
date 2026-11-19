/**
 * Doctor EMR workspace (migration 051) — DB-free contract tests.
 *
 * No database: these prove the request contract (Joi), the derived vitals
 * (BMI, waist-hip ratio, BP parsed from the legacy string), the visibility /
 * edit rule the UI and the service share, and that the dev-boot guard parses
 * every ALTER out of the migration (so the two can never drift).
 *
 *   node --test test/emr/emrContract.test.js
 */
require("../testEnv");
const test = require("node:test");
const assert = require("node:assert/strict");

const v = require("../../src/validators/emr.validator");
const S = require("../../src/utils/serializers");
const { canEditEntry } = require("../../src/services/emr.service");
const ensure = require("../../src/db/ensureEmrWorkspace");
const { regNoOf } = require("../../src/utils/patientRegNo");

const run = (schema, value) => schema.validate(value, { abortEarly: false, stripUnknown: true, convert: true });

test("vitals: a BP is a pair, diastolic < systolic, at least one value", () => {
  assert.ok(run(v.addVitals, { bpSystolic: 120 }).error, "half a BP is rejected");
  assert.ok(run(v.addVitals, { bpSystolic: 80, bpDiastolic: 120 }).error, "diastolic ≥ systolic is rejected");
  assert.ok(run(v.addVitals, { note: "nothing measured" }).error, "an empty reading is rejected");
  assert.ok(run(v.addVitals, { pulseRateBpm: 780 }).error, "an impossible pulse is rejected");
  const ok = run(v.addVitals, { bpSystolic: 120, bpDiastolic: 80, respiratoryRate: 16 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.weightKg, undefined, "an empty field is not invented as 0");
});

test("entries: each kind requires its own fields", () => {
  assert.ok(run(v.createEntry, { kind: "complaint" }).error);
  assert.ok(run(v.createEntry, { kind: "diagnosis", title: "Asthma" }).error, "diagnosis type required");
  assert.ok(run(v.createEntry, { kind: "investigation", title: "CBC", category: "laboratory", details: {} }).error, "priority required");
  assert.ok(run(v.createEntry, { kind: "history", category: "hpi", details: { presentIllness: " " } }).error, "empty history rejected");
  assert.ok(run(v.createEntry, { kind: "examination", category: "made_up_form", details: { a: "b" } }).error, "unknown form rejected");
  assert.ok(run(v.createEntry, { kind: "doctor_note", category: "progress" }).error, "note text required");
  assert.ok(run(v.createEntry, { kind: "diagnosis", title: "x", category: "final", code: "G44.2; DROP" }).error, "ICD code pattern");
  const inv = run(v.createEntry, { kind: "investigation", title: "CBC", category: "laboratory", details: { priority: "stat" } });
  assert.equal(inv.error, undefined);
  assert.equal(inv.value.details.quantity, 1);
});

test("entries: correcting needs at least one field; retire needs a reason", () => {
  assert.ok(run(v.updateEntry, {}).error);
  assert.ok(run(v.retireEntry, {}).error);
  assert.equal(run(v.retireEntry, { reason: "wrong patient" }).error, undefined);
});

test("vitals serializer: derived values and legacy BP, never invented", () => {
  const out = S.serializePatientVitals(
    [
      { id: 1, recordedOn: "2026-10-30", bloodPressure: "130/85", weightKg: "70.00", heightCm: "170.00", waistCm: "84.0", hipCm: "96.0", source: "doctor" },
      { id: 2, recordedOn: "2026-10-29", bloodPressure: null, source: "patient" },
    ],
    { age: 40, fields: S.VITALS_EMR_FIELDS }
  );
  const [a, b] = out.entries;
  assert.equal(a.values.bmi, 24.2);
  assert.equal(a.values.waistHipRatio, 0.88);
  assert.equal(a.values.bpSystolic, 130, "systolic parsed from the legacy string");
  assert.equal(a.values.bpDiastolic, 85);
  assert.equal(b.values.bmi, null);
  assert.equal(b.values.bpSystolic, null);
  assert.equal(out.fields, S.VITALS_EMR_FIELDS);
});

test("older vitals views keep their original field list", () => {
  const out = S.serializePatientVitals([], { age: 30 });
  assert.deepEqual(out.fields.map((f) => f.key), ["weightKg", "heightCm", "bmi", "pulseRateBpm", "bloodPressure", "temperatureF", "spo2Percent"]);
});

test("edit rule: author only, active, inside the window, never a published note", () => {
  const fresh = { doctorId: 7, status: "active", kind: "diagnosis", patientVisible: true, createdAt: new Date() };
  assert.equal(canEditEntry(fresh, "7"), true);
  assert.equal(canEditEntry(fresh, "8"), false, "not the author");
  assert.equal(canEditEntry({ ...fresh, status: "entered_in_error" }, "7"), false);
  assert.equal(canEditEntry({ ...fresh, createdAt: new Date(Date.now() - 25 * 3600e3) }, "7"), false, "outside 24h");
  assert.equal(canEditEntry({ ...fresh, kind: "doctor_note", patientVisible: true }, "7"), false, "published note is final");
  assert.equal(canEditEntry({ ...fresh, kind: "doctor_note", patientVisible: false }, "7"), true, "a draft note is editable");
});

test("entry serializer: viewer flags only for a doctor viewer", () => {
  const row = { id: 3, kind: "doctor_note", doctorId: 7, status: "active", patientVisible: false, createdAt: new Date() };
  assert.equal(S.serializeClinicalEntry(row).canEdit, undefined);
  const mine = S.serializeClinicalEntry(row, { viewerId: 7, canEdit: canEditEntry });
  assert.equal(mine.isMine, true);
  assert.equal(mine.canEdit, true);
});

test("registration number is the real id, zero-padded", () => {
  assert.equal(regNoOf(179), "IHS-P-000179");
  assert.equal(regNoOf(null), null);
});

test("dev-boot guard parses every ALTER and the new table out of migration 051", () => {
  const alters = ensure.alterations();
  assert.equal(alters.filter((a) => a.column).length, 19);
  assert.equal(alters.filter((a) => a.index).length, 1);
  assert.ok(alters.every((a) => !a.ddl.includes("''")), "doubled quotes are un-escaped");
  assert.ok(alters.find((a) => a.column === "interval_unit").ddl.includes("ENUM('day','week','month')"));
  assert.equal(ensure.createStatements().length, 1);
});
