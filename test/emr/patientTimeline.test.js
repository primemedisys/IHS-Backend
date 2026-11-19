/**
 * Patient timeline builder — DB-free. Proves the rules from the product brief:
 * one event per source record, a document is dated by its test date (never the
 * upload date), undated events sort last, doctors are never merged, filters and
 * pagination are applied on the server.
 *
 *   node --test test/emr/patientTimeline.test.js
 */
require("../testEnv");
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../src/services/patientTimeline.service");

const visit = (bookingId, date, doctorId, name, specs) => ({
  bookingId,
  date,
  startTime: "10:30:00",
  appointmentType: "clinic",
  status: "completed",
  clinic: { id: "1", name: "City Clinic", city: "Pune" },
  doctor: { id: doctorId, name, qualification: null, specializations: specs },
});

const rx = { id: "9", rxNumber: "RX-9", status: "finalized", bookingId: "2", visitDate: "2026-11-05", finalizedAt: "2026-11-05T05:00:00Z", createdAt: "2026-11-05T04:00:00Z", doctor: { id: "20", name: "Dr B" }, noMedication: false, items: [{ medicineName: "Paracetamol" }] };

const history = {
  consultations: [
    { visit: visit("1", "2026-11-01", "10", "Dr A", ["Orthopedics"]), isMine: false, complaints: [{ id: "c1", title: "Back pain", createdAt: "2026-11-01T05:00:00Z", author: { id: "10", name: "Dr A" } }], examinations: [], diagnoses: [], investigations: [], notes: [], vitals: [], followUp: null, prescription: null },
    { visit: visit("2", "2026-11-05", "20", "Dr B", ["General Medicine"]), isMine: true, complaints: [], examinations: [], diagnoses: [], investigations: [], notes: [], vitals: [], followUp: { followUpOn: "2026-11-12", note: "Review", status: null, doctor: { id: "20", name: "Dr B" } }, prescription: rx },
  ],
  diagnoses: [{ id: "d1", title: "Lumbar disc prolapse", code: "M51.2", codeSystem: "ICD-10", status: "active", category: "provisional", bookingId: "1", visitDate: "2026-11-01", createdAt: "2026-11-01T06:00:00Z", author: { id: "10", name: "Dr A" } }],
  prescriptionDiagnoses: [],
  investigations: [{ id: "i1", title: "MRI Lumbar Spine", bookingId: "1", visitDate: "2026-11-01", createdAt: "2026-11-01T06:10:00Z", author: { id: "10", name: "Dr A" }, details: null }],
  prescriptions: [rx],
  capped: { consultations: false, prescriptions: false },
};

const docs = [
  { id: "50", tag: "MRI report", recordDate: "2026-11-03", uploadedAt: "2026-11-04T01:00:00Z", documentKind: "mri", doctorName: "Dr R", recordedBy: null, location: "Scan Centre" },
  { id: "51", tag: "Old scan", recordDate: null, uploadedAt: "2026-11-06T01:00:00Z", documentKind: "xray", doctorName: null, recordedBy: { id: "5", name: "Patient" }, source: "patient" },
];

test("a prescription appears once, attributed to its own prescriber", () => {
  const ev = T.buildEvents(history, docs).filter((e) => e.source.kind === "prescription");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].doctor.name, "Dr B");
});

test("a document is dated by its test date; an undated one stays undated and keeps its upload date apart", () => {
  const ev = T.buildEvents(history, docs);
  const mri = ev.find((e) => e.id === "doc:50");
  const old = ev.find((e) => e.id === "doc:51");
  assert.equal(mri.date, "2026-11-03");
  assert.equal(old.date, null);
  assert.equal(old.uploadedAt, "2026-11-06T01:00:00Z");
});

test("newest first by default, oldest first on request, undated events last either way", () => {
  const desc = T.build(history, docs, {}).events;
  assert.equal(desc.at(-1).id, "doc:51");
  assert.ok(desc[0].date >= desc[1].date);
  const asc = T.build(history, docs, { order: "asc" }).events;
  assert.equal(asc.at(-1).id, "doc:51");
  assert.ok(asc[0].date <= asc[1].date);
});

test("doctor and specialty filters keep different doctors' records separate", () => {
  const a = T.build(history, docs, { doctorId: "10" }).events;
  assert.ok(a.length > 0 && a.every((e) => e.doctor.id === "10"));
  const gm = T.build(history, docs, { specialty: "general medicine" }).events;
  assert.ok(gm.length > 0 && gm.every((e) => e.specialties.includes("General Medicine")));
});

test("type groups, date range (excludes undated) and pagination", () => {
  assert.deepEqual([...new Set(T.build(history, docs, { types: "diagnoses" }).events.map((e) => e.type))], ["diagnosis"]);
  const ranged = T.build(history, docs, { from: "2026-11-03", to: "2026-11-05" }).events;
  assert.ok(ranged.every((e) => e.date >= "2026-11-03" && e.date <= "2026-11-05"));
  const p1 = T.build(history, docs, { limit: 3, page: 1 });
  const p2 = T.build(history, docs, { limit: 3, page: 2 });
  assert.equal(p1.events.length, 3);
  assert.ok(p1.total > 3 && p2.events[0].id !== p1.events[0].id);
});

test("facets list only doctors and specialties that exist in the record", () => {
  const f = T.build(history, docs, {}).facets;
  assert.deepEqual(f.doctors.map((d) => d.name).sort(), ["Dr A", "Dr B"]);
  assert.deepEqual(f.specialties, ["General Medicine", "Orthopedics"]);
});
