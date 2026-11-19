/**
 * Clinical-history consent (migration 057) + the structured medical history —
 * end-to-end API tests. Real HTTP, real database, no mocks. Every check is a
 * DIRECT API call (what a doctor could script), not UI visibility.
 *
 * Cast: doctor A (treats the patient today), doctor B (treated the patient
 * yesterday and wrote the history), doctor C (also treats the patient), the
 * patient P and another patient Q.
 *
 *  1. Common records are visible to a treating doctor with no request: history,
 *     conditions, diagnoses, notes, every vitals reading, other doctors' visits
 *     and their advice. Prescriptions/medicines and tests/reports stay private
 *     in EVERY doctor response (workspace, entries, history, visit summary,
 *     timeline, booking detail / notes / vitals, Rx PDF).
 *  2. Common sections can't be requested; A requests medications + investigations.
 *  3. P sees the requests; Q and A cannot decide them.
 *  4. P approves prescriptions only → medicines + Rx PDF open; reports stay private.
 *  5. P rejects reports → still private; asking again is held back (cool-down).
 *  6. C cannot use A's grant (C still sees the common records).
 *  7. P revokes → A loses the medicines on the very next call; audited; A notified.
 *  8. Reports follow the investigations grant; an expired grant closes and can't be reused.
 *  9. The patient's own history groups every record under the right visit,
 *     prescriber and date, with no duplicates.
 * 10. Audit fixes: document re-dating, note treatment line, unverified doctor.
 *
 * Run against an already-running API (writes tagged test data into THAT
 * server's database; the run's accounts are deactivated at the end):
 *   PORT=5055 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 node src/server.js
 *   CONSENT_E2E_BASE_URL=http://localhost:5055 node --test test/clinicalConsent/clinicalConsent.test.js
 */
const path = require("path");

const EXTERNAL = process.env.CONSENT_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  sequelize,
  User,
  Booking,
  Prescription,
  PrescriptionItem,
  PatientVitals,
  UploadedRecord,
  DoctorAccessRequest,
  AccessAuditLog,
  MedicineNotification,
} = require("../../src/models");
const passwordUtil = require("../../src/utils/password");

const RUN = Date.now().toString(36);
const PASSWORD = "Consent#2026x";
let server;
let base;
const S = {};

// Distinctive strings written ONLY by doctor B / the patient — a leak shows up as a substring.
const SECRET = {
  history: `Childhood asthma ${RUN}`,
  condition: `Type 2 diabetes ${RUN}`,
  diagnosis: `Lumbar spondylosis ${RUN}`,
  test: `X-ray LS spine ${RUN}`,
  note: `Advised physiotherapy ${RUN}`,
  med1: `Zerodol${RUN}`,
  med2: `PanD${RUN}`,
  advice: `Hot fomentation ${RUN}`,
  doc: `lab-${RUN}.pdf`,
};
const OWN_COMPLAINT = `Neck stiffness ${RUN}`;

async function call(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}/api${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, data: json?.data, text };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${res.text?.slice(0, 600)}`);
}

/** The response body must not contain any of the given secrets. */
function assertNoLeak(res, label, secrets = Object.values(SECRET)) {
  for (const s of secrets) assert.ok(!res.text.includes(s), `${label} leaked "${s}"`);
}

const email = (who) => `consent-${who}-${RUN}@ihs-test.example.com`;
const ist = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));

async function makeUser(who, role) {
  const hash = await passwordUtil.hash(PASSWORD);
  const [cols] = await sequelize.query("SHOW COLUMNS FROM users");
  const names = new Set(cols.map((c) => c.Field));
  const row = { role, name: `${who} Consent${RUN}`, email: email(who), password_hash: hash, is_active: 1, is_email_verified: 1 };
  if (names.has("userName")) row.userName = `${who}${RUN}`.slice(0, 50);
  if (names.has("phoneNumber")) row.phoneNumber = "9000000000";
  const keys = Object.keys(row);
  const [id] = await sequelize.query(`INSERT INTO users (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, {
    replacements: keys.map((k) => row[k]),
  });
  return Number(id);
}

async function login(who, audience) {
  const res = await post("/auth/login", { body: { email: email(who), password: PASSWORD, audience } });
  expectStatus(res, 200, `login ${who}`);
  return res.data.tokens?.accessToken ?? res.data.accessToken;
}

async function makeBooking(doctor, patient, { day, status, start = "10:00:00" }) {
  const b = await Booking.create({
    patientId: patient,
    doctorId: doctor,
    bookingType: "online",
    slotDate: day,
    slotStartTime: start,
    slotEndTime: start.replace(/:00:00$/, ":15:00"),
    paymentMode: "online",
    amount: 0,
    status,
  });
  S.bookings.push(b.id);
  return String(b.id);
}

async function entry(token, bookingId, body) {
  const res = await post(`/doctor/emr/bookings/${bookingId}/entries`, { token, body });
  expectStatus(res, 201, `entry ${body.kind}`);
  return res.data;
}

const P = () => S.pat.id;
const emr = (p = "") => `/doctor/emr/patients/${P()}${p}`;
const request = (token, categories, purpose = "Continuing treatment for back pain") =>
  post(emr("/access-requests"), { token, body: { categories, purpose } });
const pending = (category) =>
  DoctorAccessRequest.findOne({ where: { doctorId: S.docA.id, patientId: P(), category }, order: [["id", "DESC"]] });

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  S.bookings = [];

  for (const key of ["docA", "docB", "docC"]) {
    S[key] = { id: await makeUser(key, "doctor") };
    await sequelize.query(
      "INSERT INTO doctor_profiles (user_id, registration_number, verification_status) VALUES (?, ?, 'approved')",
      { replacements: [S[key].id, `REG-CON-${key}-${RUN}`] }
    );
  }
  for (const key of ["pat", "patQ"]) {
    S[key] = { id: await makeUser(key, "patient") };
    await sequelize.query("INSERT INTO patient_profiles (user_id) VALUES (?)", { replacements: [S[key].id] });
  }
  for (const key of ["docA", "docB", "docC"]) S[key].token = await login(key, "doctor");
  S.pat.token = await login("pat", "patient");
  S.patQ.token = await login("patQ", "patient");

  // Doctor B's visit yesterday — written while confirmed, then completed.
  S.b1 = await makeBooking(S.docB.id, P(), { day: ist(-1), status: "confirmed" });
  const t = S.docB.token;
  S.bComplaint = await entry(t, S.b1, { kind: "complaint", title: `Low back pain ${RUN}` });
  S.bHistory = await entry(t, S.b1, { kind: "history", category: "hpi", details: { pastIllness: SECRET.history } });
  S.bCondition = await entry(t, S.b1, { kind: "comorbidity", category: "diabetes", title: SECRET.condition });
  S.bDiagnosis = await entry(t, S.b1, { kind: "diagnosis", title: SECRET.diagnosis, category: "final" });
  S.bTest = await entry(t, S.b1, { kind: "investigation", title: SECRET.test, category: "radiology", details: { priority: "routine" } });
  S.bNote = await entry(t, S.b1, { kind: "doctor_note", category: "progress", remarks: SECRET.note, patientVisible: true });
  await PatientVitals.create({
    patientId: P(),
    bookingId: S.b1,
    recordedOn: ist(-1),
    recordedAt: new Date(Date.now() - 86_400_000),
    bpSystolic: 132,
    bpDiastolic: 86,
    bloodPressure: "132/86",
    source: "doctor",
    recordedByUserId: S.docB.id,
  });
  const rx = await Prescription.create({
    bookingId: S.b1,
    doctorId: S.docB.id,
    patientId: P(),
    status: "finalized",
    version: 1,
    rxNumber: `RX-CON-${RUN}`,
    chiefComplaint: `Low back pain ${RUN}`,
    diagnosis: SECRET.diagnosis,
    advice: SECRET.advice,
    finalizedAt: new Date(),
  });
  S.rxId = String(rx.id);
  await PrescriptionItem.bulkCreate([
    { prescriptionId: rx.id, sortOrder: 0, medicineName: SECRET.med1, strength: "100 mg", dosage: "1 tab", frequency: "BD", timing: "after_food", durationDays: 5 },
    { prescriptionId: rx.id, sortOrder: 1, medicineName: SECRET.med2, dosage: "1 cap", frequency: "OD", timing: "before_food", durationDays: 5 },
  ]);
  await Booking.update({ status: "completed" }, { where: { id: S.b1 } });

  // A home reading and an uploaded lab report from the patient.
  await PatientVitals.create({ patientId: P(), recordedOn: ist(0), pulseRateBpm: 177, source: "patient", recordedByUserId: P() });
  S.recordId = (
    await UploadedRecord.create({ patientId: P(), fileUrl: `/uploads/records/${SECRET.doc}`, fileType: "lab_report", source: "patient" })
  ).id;

  // Doctor A and doctor C both treat the patient today.
  S.b2 = await makeBooking(S.docA.id, P(), { day: ist(0), status: "confirmed", start: "11:00:00" });
  S.b3 = await makeBooking(S.docC.id, P(), { day: ist(0), status: "confirmed", start: "12:00:00" });
  await entry(S.docA.token, S.b2, { kind: "complaint", title: OWN_COMPLAINT });
});

after(async () => {
  const ids = ["docA", "docB", "docC", "pat", "patQ"].map((k) => S[k]?.id).filter(Boolean);
  if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  if (S.bookings?.length) await Booking.update({ status: "cancelled" }, { where: { id: S.bookings } }).catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

// ── 1. Default visibility (IHS policy 2026-11-03) ────────────────────────────
// Common clinical information is visible to a treating doctor with no request;
// only prescriptions/medicines and tests/reports wait for the patient.
const PROTECTED = () => [SECRET.med1, SECRET.med2, SECRET.test, SECRET.doc];

describe("No request yet: common records visible, prescriptions and reports private", () => {
  it("workspace: every visit and every vitals reading, only two sections to request", async () => {
    const res = await get(emr(), { token: S.docA.token });
    expectStatus(res, 200, "workspace");
    assertNoLeak(res, "workspace", PROTECTED());
    assert.deepEqual(res.data.visits.map((v) => v.bookingId).sort(), [S.b1, S.b2].sort(), "doctor B's visit visible");
    assert.ok(res.text.includes("177"), "home reading visible");
    const byCat = Object.fromEntries(res.data.access.categories.map((c) => [c.category, c]));
    for (const c of ["medical_history", "consultations", "diagnoses", "doctor_notes", "vitals"]) {
      assert.equal(byCat[c].status, "open", `${c} open`);
      assert.equal(byCat[c].canRequest, false, `${c} needs no request`);
    }
    for (const c of ["medications", "investigations"]) {
      assert.equal(byCat[c].status, "none", `${c} private`);
      assert.equal(byCat[c].canRequest, true, `${c} requestable`);
    }
  });

  it("entries / vitals / history: history, conditions, diagnoses, notes, vitals and advice — no medicines or tests", async () => {
    const entries = await get(emr("/entries"), { token: S.docA.token });
    expectStatus(entries, 200, "entries");
    assertNoLeak(entries, "entries", PROTECTED());
    assert.ok(entries.text.includes(SECRET.diagnosis) && entries.text.includes(SECRET.history), "B's diagnosis + history entries visible");

    const vitals = await get(emr("/vitals"), { token: S.docA.token });
    expectStatus(vitals, 200, "vitals");
    assert.ok(vitals.text.includes("177") && vitals.text.includes("132/86"), "every reading visible");

    const history = await get(emr("/history"), { token: S.docA.token });
    expectStatus(history, 200, "history");
    assertNoLeak(history, "history", PROTECTED());
    for (const s of [SECRET.history, SECRET.condition, SECRET.diagnosis, SECRET.note]) assert.ok(history.text.includes(s), `history shows "${s}"`);
    assert.deepEqual([...history.data.lockedCategories].sort(), ["investigations", "medications"]);
    const card = history.data.consultations.find((c) => c.visit.bookingId === S.b1);
    assert.ok(card, "B's consultation listed");
    assert.equal(card.prescription, null, "prescription private");
    assert.equal(card.investigations, null, "ordered tests private");
    assert.equal(card.advice, SECRET.advice, "advice is part of the consultation");
    assert.ok(card.diagnoses.some((d) => d.title === SECRET.diagnosis));
    assert.equal(card.vitals[0]?.values.bloodPressure, "132/86");
    assert.equal(history.data.prescriptions.length, 0, "no prescriptions listed");
  });

  it("visit summary, timeline and booking views follow the same rule; the Rx PDF stays closed", async () => {
    const v = await get(emr(`/visits/${S.b1}`), { token: S.docA.token });
    expectStatus(v, 200, "visit summary");
    assert.ok(v.text.includes(SECRET.diagnosis) && v.text.includes(SECRET.advice), "diagnosis + advice visible");
    assertNoLeak(v, "visit summary", PROTECTED());
    assert.deepEqual([...v.data.locked].sort(), ["investigations", "medications"]);
    expectStatus(await get(`/doctor/prescriptions/${S.rxId}/pdf`, { token: S.docA.token }), 404, "rx pdf");

    const timeline = await get(`/doctor/patients/${P()}/timeline`, { token: S.docA.token });
    expectStatus(timeline, 200, "timeline");
    const row = timeline.data.rows.find((r) => r.bookingId === S.b1);
    assert.ok(row, "B's visit on the timeline");
    assert.equal(row.prescription, null, "its prescription private");

    for (const p of [`/bookings/${S.b2}`, `/bookings/${S.b2}/clinical-notes`, `/bookings/${S.b2}/patient-vitals`, `/bookings/${S.b2}/patient-timeline`]) {
      const res = await get(`/doctor${p}`, { token: S.docA.token });
      expectStatus(res, 200, p);
      assertNoLeak(res, p, PROTECTED());
    }
  });

  it("refuses strangers: no auth 401, a patient 403, a patient the doctor doesn't treat 404", async () => {
    expectStatus(await get(emr("/history")), 401, "anon");
    expectStatus(await get(emr("/history"), { token: S.pat.token }), 403, "patient on doctor route");
    const other = await get(`/doctor/emr/patients/${S.patQ.id}/history`, { token: S.docA.token });
    expectStatus(other, 404, "no relationship");
    assertNoLeak(other, "no relationship");
    expectStatus(await post(`/doctor/emr/patients/${S.patQ.id}/access-requests`, { token: S.docA.token, body: { categories: ["medications"] } }), 404, "request w/o relationship");
  });
});

// ── 2–6. Request, decide, cool-down, isolation ───────────────────────────────
describe("Protected sections: request and decision", () => {
  it("common sections can't be requested; medications + investigations → one row each, one notification", async () => {
    const open = await request(S.docA.token, ["medical_history", "vitals"]);
    expectStatus(open, 409, "requesting a common section");
    assert.match(open.body.error.message, /already visible/);

    const res = await request(S.docA.token, ["medications", "investigations"]);
    expectStatus(res, 201, "request");
    const byCat = Object.fromEntries(res.data.categories.map((c) => [c.category, c]));
    assert.equal(byCat.medications.status, "pending");
    assert.equal(byCat.investigations.status, "pending");

    const n = await MedicineNotification.findOne({ where: { userId: P(), type: "record_access_requested" }, order: [["id", "DESC"]] });
    assert.ok(n, "patient notified");
    assert.match(n.message, /requested access to your previous medical records/);
    assert.match(n.message, /prescriptions & medicines/);

    const dup = await request(S.docA.token, ["medications"]);
    expectStatus(dup, 409, "duplicate");
    assert.equal(dup.body.error.code, "ACCESS_REQUEST_PENDING");
    expectStatus(await request(S.docA.token, ["everything"]), 422, "unknown category");
  });

  it("patient sees the requests with the doctor's details; other users can't decide them", async () => {
    const list = await get("/patient/access-requests?status=pending", { token: S.pat.token });
    expectStatus(list, 200, "patient list");
    const mine = list.data.requests.filter((r) => r.doctor.id === String(S.docA.id));
    assert.deepEqual(mine.map((r) => r.category).sort(), ["investigations", "medications"]);
    assert.ok(mine[0].doctor.name.includes("docA"));
    assert.equal(mine[0].purpose, "Continuing treatment for back pain");

    S.reqMeds = String((await pending("medications")).id);
    S.reqTests = String((await pending("investigations")).id);
    expectStatus(await get(`/patient/access-requests/${S.reqMeds}`, { token: S.patQ.token }), 404, "other patient read");
    expectStatus(await post(`/patient/access-requests/${S.reqMeds}/approve`, { token: S.patQ.token, body: {} }), 404, "other patient approve");
    expectStatus(await post(`/patient/access-requests/${S.reqMeds}/approve`, { token: S.docA.token, body: {} }), 403, "doctor approve");
  });

  it("patient approves prescriptions ONLY → doctor sees the medicines; tests and reports stay private", async () => {
    const ok = await post(`/patient/access-requests/${S.reqMeds}/approve`, { token: S.pat.token, body: { durationDays: 7 } });
    expectStatus(ok, 200, "approve");
    assert.equal(ok.data.status, "approved");
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.docA.id, type: "record_access_approved", referenceId: S.reqMeds } }));

    const h = await get(emr("/history"), { token: S.docA.token });
    expectStatus(h, 200, "history after approve");
    assert.ok(h.text.includes(SECRET.med1) && h.text.includes(SECRET.med2), "medicines visible");
    assertNoLeak(h, "history (tests private)", [SECRET.test, SECRET.doc]);
    assert.deepEqual(h.data.lockedCategories, ["investigations"]);
    const rx = h.data.prescriptions.find((p) => p.id === S.rxId);
    assert.equal(rx?.items[0].strength, "100 mg", "strength as prescribed");
    assert.equal(rx?.items[1].strength, null, "missing strength not invented");
    // The consent gate opens (no longer 404). The fixture Rx has no print-template
    // snapshot, so rendering itself may 500 here — that is not an access decision.
    const pdf = await get(`/doctor/prescriptions/${S.rxId}/pdf`, { token: S.docA.token });
    assert.notEqual(pdf.status, 404, "rx pdf no longer hidden");
    assert.ok(pdf.status === 200 || pdf.body?.error?.code === "PDF_RENDER_FAILED", `rx pdf: ${pdf.status} ${pdf.text.slice(0, 200)}`);
  });

  it("patient rejects tests & reports → stays private, doctor notified, asking again is held back", async () => {
    const res = await post(`/patient/access-requests/${S.reqTests}/reject`, { token: S.pat.token, body: {} });
    expectStatus(res, 200, "reject");
    assert.equal(res.data.status, "rejected");
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.docA.id, type: "record_access_rejected", referenceId: S.reqTests } }));

    const h = await get(emr("/history"), { token: S.docA.token });
    assertNoLeak(h, "history after reject", [SECRET.test, SECRET.doc]);
    const booking = await get(`/doctor/bookings/${S.b2}`, { token: S.docA.token });
    assertNoLeak(booking, "booking after reject", [SECRET.doc]);
    const again = await request(S.docA.token, ["investigations"]);
    expectStatus(again, 409, "re-request");
    assert.equal(again.body.error.code, "ACCESS_REQUEST_COOLDOWN");
    expectStatus(await post(`/patient/access-requests/${S.reqTests}/approve`, { token: S.pat.token, body: {} }), 409, "approve after reject");
  });

  it("another doctor cannot use doctor A's permission (but sees the common records)", async () => {
    const h = await get(emr("/history"), { token: S.docC.token });
    expectStatus(h, 200, "doctor C history");
    assertNoLeak(h, "doctor C history", PROTECTED());
    assert.ok(h.text.includes(SECRET.history), "common history visible to C too");
    expectStatus(await get(`/doctor/prescriptions/${S.rxId}/pdf`, { token: S.docC.token }), 404, "C rx pdf");
  });
});

// ── 7–8. Revocation and expiry ───────────────────────────────────────────────
describe("Revocation and expiry", () => {
  it("revoking prescriptions closes them on the very next call, is audited and notifies the doctor", async () => {
    const res = await post(`/patient/access-requests/${S.reqMeds}/revoke`, { token: S.pat.token });
    expectStatus(res, 200, "revoke");
    assert.equal(res.data.status, "revoked");
    const h = await get(emr("/history"), { token: S.docA.token });
    assertNoLeak(h, "history after revoke", [SECRET.med1, SECRET.med2]);
    assert.ok(h.text.includes(SECRET.history), "common records unaffected");
    expectStatus(await get(`/doctor/prescriptions/${S.rxId}/pdf`, { token: S.docA.token }), 404, "rx pdf after revoke");
    assert.ok(await AccessAuditLog.findOne({ where: { action: "access_revoked", entityId: S.reqMeds } }));
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.docA.id, type: "record_access_revoked", referenceId: S.reqMeds } }));
    expectStatus(await post(`/patient/access-requests/${S.reqMeds}/revoke`, { token: S.pat.token }), 409, "revoke twice");
  });

  it("uploaded reports follow the investigations grant, and an expired grant closes them for good", async () => {
    const before = await get(`/doctor/bookings/${S.b3}`, { token: S.docC.token });
    assert.ok(!before.text.includes(SECRET.doc), "lab report hidden from C");
    expectStatus(await request(S.docC.token, ["investigations"]), 201, "C requests investigations");
    const r = await DoctorAccessRequest.findOne({ where: { doctorId: S.docC.id, patientId: P(), category: "investigations" }, order: [["id", "DESC"]] });
    expectStatus(await post(`/patient/access-requests/${r.id}/approve`, { token: S.pat.token, body: {} }), 200, "approve");
    const shared = await get(`/doctor/bookings/${S.b3}`, { token: S.docC.token });
    assert.ok(shared.data.patient.uploadedRecords.some((x) => String(x.id) === String(S.recordId)), "lab report shared with C");
    const h = await get(emr("/history"), { token: S.docC.token });
    assert.ok(h.text.includes(SECRET.test), "ordered tests visible to C");
    assertNoLeak(await get(emr("/history"), { token: S.docA.token }), "A still private", [SECRET.test, SECRET.doc]);

    await DoctorAccessRequest.update({ grantExpiresAt: new Date(Date.now() - 60_000) }, { where: { id: r.id } });
    const after = await get(`/doctor/bookings/${S.b3}`, { token: S.docC.token });
    assert.ok(!after.text.includes(SECRET.doc), "lab report closed after expiry");
    const row = await DoctorAccessRequest.findByPk(r.id);
    assert.equal(row.status, "expired");
    assert.ok(await AccessAuditLog.findOne({ where: { action: "access_expired", entityId: r.id } }));
    expectStatus(await post(`/patient/access-requests/${r.id}/approve`, { token: S.pat.token, body: {} }), 409, "re-approve expired");
    expectStatus(await post(`/patient/access-requests/${r.id}/revoke`, { token: S.pat.token }), 409, "revoke expired");
  });
});

// ── 10. The patient's own record ─────────────────────────────────────────────
describe("Patient's structured history", () => {
  it("groups each record under the right visit, prescriber and date — no duplicates", async () => {
    const res = await get("/patient/medical-history", { token: S.pat.token });
    expectStatus(res, 200, "patient history");
    const d = res.data;
    const ids = d.consultations.map((c) => c.visit.bookingId);
    assert.equal(new Set(ids).size, ids.length, "no duplicate visits");
    assert.ok(!ids.includes(S.b2), "unfinished visits are not history yet");

    const b1 = d.consultations.find((c) => c.visit.bookingId === S.b1);
    assert.ok(b1, "B's consultation present");
    assert.equal(b1.visit.doctor.id, String(S.docB.id));
    assert.equal(b1.prescription.doctor.id, String(S.docB.id), "prescriber = prescription's doctor");
    assert.deepEqual(b1.prescription.items.map((i) => i.medicineName), [SECRET.med1, SECRET.med2]);
    assert.equal(b1.prescription.items[0].strength, "100 mg");
    assert.equal(b1.prescription.items[1].strength, null, "missing strength is not invented");
    assert.equal(b1.prescription.advice, SECRET.advice);
    assert.ok(b1.diagnoses.some((x) => x.title === SECRET.diagnosis));
    assert.ok(b1.notes.some((x) => x.remarks === SECRET.note), "published note shown");
    assert.ok(b1.complaints.some((x) => x.title === `Low back pain ${RUN}`));
    assert.deepEqual(d.lockedCategories, []);

    const rx = d.prescriptions.filter((p) => p.id === S.rxId);
    assert.equal(rx.length, 1, "prescription listed once");
    assert.equal(rx[0].bookingId, S.b1);
    assert.ok(d.medicalHistory.some((e) => e.details?.pastIllness === SECRET.history));
    assert.ok(d.longTermConditions.some((e) => e.title === SECRET.condition));
    assert.equal(d.access, null);
  });

  it("a doctor cannot read the patient route", async () => {
    expectStatus(await get("/patient/medical-history", { token: S.docA.token }), 403, "doctor on patient route");
  });
});

// ── 11. Gaps closed by the 2026-11-03 audit ──────────────────────────────────
/** Give doctor A an in-force grant directly (the request/approve flow is covered above). */
async function grantA(category) {
  const now = new Date();
  return DoctorAccessRequest.create({
    doctorId: S.docA.id,
    patientId: P(),
    category,
    purpose: "Audit regression check",
    status: "approved",
    requestExpiresAt: new Date(now.getTime() + 86_400_000),
    decidedAt: now,
    grantExpiresAt: new Date(now.getTime() + 86_400_000),
  });
}

describe("Audit fixes: no side doors", () => {
  it("re-dating a patient document follows the same grant as reading it", async () => {
    // An uploaded prescription is a `medications` document — revoked for A above.
    const locked = await UploadedRecord.create({
      patientId: P(),
      fileUrl: `/uploads/records/rx-${RUN}.pdf`,
      fileType: "prescription",
      source: "patient",
    });
    const patch = (id) => call("PATCH", `/doctor/bookings/${S.b2}/patient-records/${id}`, { token: S.docA.token, body: { recordDate: ist(-30) } });

    const denied = await patch(locked.id);
    expectStatus(denied, 404, "PATCH a locked document");
    assert.ok(!denied.text.includes(`rx-${RUN}`), "no file link for a locked document");
    await locked.reload();
    assert.equal(locked.recordDate ?? null, null, "locked document left unchanged");

    // With tests & reports shared, correcting the lab report's date works.
    await grantA("investigations");
    expectStatus(await patch(S.recordId), 200, "PATCH a shared document");
  });

  it("a legacy note's treatment line (the medication plan) needs the medications grant", async () => {
    const { ClinicalNote } = require("../../src/models");
    const complaint = `Radiating pain ${RUN}`;
    const treatment = `Tab Pregabalin ${RUN}`;
    await ClinicalNote.create({ patientId: P(), doctorId: S.docB.id, bookingId: S.b1, complaints: complaint, treatment, source: "doctor", recordedByUserId: S.docB.id });
    for (const p of [emr("/history"), `/doctor/bookings/${S.b2}/clinical-notes`]) {
      const res = await get(p, { token: S.docA.token });
      expectStatus(res, 200, p);
      assert.ok(res.text.includes(complaint), `${p}: note visible (common)`);
      assert.ok(!res.text.includes(treatment), `${p}: treatment hidden without the medications grant`);
    }
  });
});

describe("Audit fixes: verification withdrawn", () => {
  it("a doctor no longer verified keeps the common records but loses patient grants", async () => {
    const hasDoc = (res) => (res.data?.patient?.uploadedRecords ?? []).some((x) => String(x.id) === String(S.recordId));
    assert.ok(hasDoc(await get(`/doctor/bookings/${S.b2}`, { token: S.docA.token })), "report shared while verified");
    await sequelize.query("UPDATE doctor_profiles SET verification_status = 'pending' WHERE user_id = ?", { replacements: [S.docA.id] });
    try {
      const res = await get(`/doctor/bookings/${S.b2}`, { token: S.docA.token });
      assert.ok([200, 403].includes(res.status), `booking: unexpected ${res.status}`);
      assert.ok(!hasDoc(res), "granted report hidden while unverified");
      assertNoLeak(res, "booking while unverified", [SECRET.doc]);
    } finally {
      await sequelize.query("UPDATE doctor_profiles SET verification_status = 'approved' WHERE user_id = ?", { replacements: [S.docA.id] });
    }
    assert.ok(hasDoc(await get(`/doctor/bookings/${S.b2}`, { token: S.docA.token })), "grant honoured again once re-approved");
  });
});

// ── 12. My Patients roster (search / pages / no enumeration) ─────────────────
describe("My Patients roster", () => {
  it("search by registration number, server-side pages, and only treated patients", async () => {
    const regNo = `IHS-P-${String(P()).padStart(6, "0")}`;
    const hit = await get(`/doctor/patients?page=1&limit=5&q=${encodeURIComponent(regNo)}`, { token: S.docA.token });
    expectStatus(hit, 200, "roster search");
    assert.equal(hit.data.total, 1, "exactly the searched patient");
    assert.equal(hit.data.page, 1);
    assert.equal(hit.data.totalPages, 1);
    const row = hit.data.patients[0];
    assert.equal(row.patient.id, String(P()));
    assert.ok(row.patient.regNo.endsWith(String(P())), "regNo returned");
    assert.ok("age" in row.patient && "gender" in row.patient, "age + gender fields present");
    assert.ok(row.consultationCount >= 1 && row.lastSeenOn, "visit count + last visit");

    const byName = await get(`/doctor/patients?page=1&q=${encodeURIComponent(`pat Consent${RUN}`)}`, { token: S.docA.token });
    expectStatus(byName, 200, "roster by name");
    assert.ok(byName.data.patients.some((r) => r.patient.id === String(P())));

    const stranger = await get(`/doctor/patients?page=1&q=${encodeURIComponent(`patQ Consent${RUN}`)}`, { token: S.docA.token });
    expectStatus(stranger, 200, "roster stranger");
    assert.equal(stranger.data.total, 0, "a patient the doctor never treated is not listable");

    // Category filter runs in SQL (pages stay correct): one visit with A → new patient.
    const asNew = await get(`/doctor/patients?page=1&status=new_patient&q=${encodeURIComponent(regNo)}`, { token: S.docA.token });
    expectStatus(asNew, 200, "status filter");
    assert.equal(asNew.data.total, 1, "derived new patient");
    assert.equal(asNew.data.patients[0].status, "new_patient");
    const asSurgery = await get(`/doctor/patients?page=1&status=surgery_pending&q=${encodeURIComponent(regNo)}`, { token: S.docA.token });
    assert.equal(asSurgery.data.total, 0, "no override → not surgery pending");
    const legacy = await get("/doctor/patients", { token: S.docA.token });
    expectStatus(legacy, 200, "legacy roster");
    assert.ok(Array.isArray(legacy.data.patients) && legacy.data.page === undefined, "unpaged call unchanged");

    expectStatus(await get("/doctor/patients?limit=1000", { token: S.docA.token }), 422, "limit capped");
    expectStatus(await get("/doctor/patients", { token: S.pat.token }), 403, "patient refused");
  });
});
