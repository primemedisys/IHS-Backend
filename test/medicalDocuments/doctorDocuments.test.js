/**
 * Patient documents in the doctor's Patient Workbench —
 * GET /doctor/emr/patients/:patientId/documents (patient → API → MySQL →
 * storage → doctor). Real uploads through the patient API, real consent
 * requests and decisions; nothing is mocked.
 *
 *  1. The patient uploads prescriptions, lab reports, imaging, ECG, discharge
 *     summary, certificate (+ an Aadhaar card); the rows carry patient id,
 *     category, dates, title, description, original file name and type.
 *  2. Common information (profile, vitals, workspace) is visible to the
 *     treating doctor with no request; documents are not — except the one
 *     the doctor filed.
 *  3. A pending request exposes nothing; approval of ONE category exposes that
 *     category only; a rejection keeps it private; a revocation closes it again.
 *  4. Identity documents never reach a doctor; another patient's documents
 *     never appear; a non-treating doctor gets 404; the booking snapshot obeys
 *     the same rules (no bypass through another endpoint).
 *  5. A document shared one-by-one (migration 045) shows as stream-only and is
 *     readable through the audited endpoint.
 *
 *   MEDICAL_DOCS_E2E_BASE_URL=http://127.0.0.1:5070 node --test test/medicalDocuments/doctorDocuments.test.js
 */
const path = require("path");

const EXTERNAL = process.env.MEDICAL_DOCS_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { sequelize, User, Booking, UploadedRecord, MedicineNotification, PatientVitals } = require("../../src/models");
const passwordUtil = require("../../src/utils/password");
const uploadService = require("../../src/services/upload.service");

const RUN = Date.now().toString(36);
const PASSWORD = "DocDocs#2026x";
let server;
let base;
const S = { bookings: [] };

async function call(method, urlPath, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${urlPath}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, data: json?.data, text, raw: buf, headers: res.headers };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${res.text?.slice(0, 500)}`);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const email = (who) => `docdocs-${who}-${RUN}@ihs-test.example.com`;
const ist = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));

async function makeUser(who, role) {
  const hash = await passwordUtil.hash(PASSWORD);
  const [cols] = await sequelize.query("SHOW COLUMNS FROM users");
  const names = new Set(cols.map((c) => c.Field));
  const row = { role, name: `${who} DocDocs${RUN}`, email: email(who), password_hash: hash, is_active: 1, is_email_verified: 1 };
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
async function makeBooking(doctor, patient, { day, status }) {
  const b = await Booking.create({
    patientId: patient,
    doctorId: doctor,
    bookingType: "online",
    slotDate: day,
    slotStartTime: "11:00:00",
    slotEndTime: "11:15:00",
    paymentMode: "online",
    amount: 0,
    status,
  });
  S.bookings.push(b.id);
  return String(b.id);
}
async function upload(who, bytes, name, type, fields) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await post("/patient/records/upload", { token: S[who].token, form });
  expectStatus(res, 201, `upload ${fields.documentKind}`);
  return res.data;
}

// Distinctive titles — a leak shows up as a substring of the response text.
const T = {
  rx: `Outside Rx ${RUN}`,
  blood: `CBC panel ${RUN}`,
  xray: `Chest X-ray ${RUN}`,
  ct: `CT head ${RUN}`,
  ecg: `ECG trace ${RUN}`,
  discharge: `Discharge summary ${RUN}`,
  cert: `Fitness certificate ${RUN}`,
  aadhaar: `Aadhaar ${RUN}`,
  other: `Other patient report ${RUN}`,
};
const PRIVATE = [T.rx, T.blood, T.xray, T.ct, T.ecg, T.discharge, T.cert];
const docs = (who) => get(`/doctor/emr/patients/${S.pat.id}/documents`, { token: S[who].token });
const titles = (res) => res.data.map((d) => d.tag);

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  for (const key of ["docA", "docB", "docC"]) {
    S[key] = { id: await makeUser(key, "doctor") };
    await sequelize.query("INSERT INTO doctor_profiles (user_id, registration_number, verification_status) VALUES (?, ?, 'approved')", {
      replacements: [S[key].id, `REG-DD-${key}-${RUN}`],
    });
  }
  for (const key of ["pat", "patQ"]) {
    S[key] = { id: await makeUser(key, "patient") };
    await sequelize.query("INSERT INTO patient_profiles (user_id, date_of_birth, gender) VALUES (?, '1988-05-01', 'female')", { replacements: [S[key].id] });
  }
  for (const key of ["docA", "docB", "docC"]) S[key].token = await login(key, "doctor");
  S.pat.token = await login("pat", "patient");
  S.patQ.token = await login("patQ", "patient");

  // Doctor A treats the patient (confirmed visit today). B and C do not (yet).
  S.bookingA = await makeBooking(S.docA.id, S.pat.id, { day: ist(0), status: "confirmed" });
  // A vitals reading — common information.
  await PatientVitals.create({ patientId: S.pat.id, recordedOn: ist(-2), bpSystolic: 124, bpDiastolic: 82, bloodPressure: "124/82", source: "patient", recordedByUserId: S.pat.id, location: "Home" });

  const common = { recordDate: ist(-10), location: "City Hospital", doctorName: "Dr. Outside", description: "Uploaded for review" };
  S.rx = await upload("pat", PDF, "rx.pdf", "application/pdf", { ...common, documentKind: "prescription", tag: T.rx });
  S.blood = await upload("pat", PDF, "cbc.pdf", "application/pdf", { ...common, documentKind: "blood_test", tag: T.blood });
  S.xray = await upload("pat", PNG, "chest.png", "image/png", { ...common, documentKind: "xray", tag: T.xray });
  S.ct = await upload("pat", PDF, "ct.pdf", "application/pdf", { ...common, documentKind: "ct_scan", tag: T.ct });
  S.ecg = await upload("pat", PDF, "ecg.pdf", "application/pdf", { ...common, documentKind: "ecg", tag: T.ecg });
  S.discharge = await upload("pat", PDF, "discharge.pdf", "application/pdf", { ...common, documentKind: "discharge_summary", tag: T.discharge });
  S.cert = await upload("pat", PDF, "cert.pdf", "application/pdf", { ...common, documentKind: "medical_certificate", tag: T.cert });
  S.aadhaar = await upload("pat", PNG, "aadhaar.png", "image/png", { documentKind: "aadhaar", tag: T.aadhaar, idLast4: "4321" });
  S.otherPatient = await upload("patQ", PDF, "q.pdf", "application/pdf", { documentKind: "lab_report", tag: T.other });
  // A document Doctor A filed (e.g. the copy of an IHS prescription they signed).
  S.ownDoc = await UploadedRecord.create({
    patientId: S.pat.id,
    fileUrl: "https://example.invalid/own-filed.pdf",
    fileType: "prescription",
    tag: `RX-OWN-${RUN}`,
    source: "doctor",
    recordedByUserId: S.docA.id,
  });
});

after(async () => {
  const patients = [S.pat?.id, S.patQ?.id].filter(Boolean);
  if (patients.length) {
    for (const r of await UploadedRecord.findAll({ where: { patientId: patients } })) {
      const key = uploadService.keyFromUrl(r.fileUrl);
      if (key && key.startsWith("patient/")) await uploadService.remove(key).catch(() => {});
      await r.destroy();
    }
    await PatientVitals.destroy({ where: { patientId: patients } });
  }
  const ids = ["docA", "docB", "docC", "pat", "patQ"].map((k) => S[k]?.id).filter(Boolean);
  if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  if (S.bookings.length) await Booking.update({ status: "cancelled" }, { where: { id: S.bookings } }).catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("1. Patient uploads are stored correctly", () => {
  it("each row carries the patient, category, dates, title, description, file name and type", async () => {
    const row = await UploadedRecord.findByPk(S.ct.id);
    assert.equal(String(row.patientId), String(S.pat.id));
    assert.equal(row.documentKind, "ct_scan");
    assert.equal(row.fileType, "other");
    assert.equal(row.recordDate, ist(-10));
    assert.ok(row.uploadedAt);
    assert.equal(row.tag, T.ct);
    assert.equal(row.description, "Uploaded for review");
    assert.equal(row.originalName, "ct.pdf");
    assert.equal(row.mimeType, "application/pdf");
    assert.equal(row.source, "patient");
    const mine = await get("/patient/records", { token: S.pat.token });
    for (const k of ["rx", "blood", "xray", "ct", "ecg", "discharge", "cert", "aadhaar"]) {
      assert.ok(mine.data.some((r) => r.id === S[k].id), `patient sees own ${k}`);
    }
  });
});

describe("2. Default visibility for the treating doctor", () => {
  it("profile, workspace and vitals open with no request; prescriptions and reports need consent", async () => {
    const ws = await get(`/doctor/emr/patients/${S.pat.id}`, { token: S.docA.token });
    expectStatus(ws, 200, "workspace");
    const vit = await get(`/doctor/emr/patients/${S.pat.id}/vitals`, { token: S.docA.token });
    expectStatus(vit, 200, "vitals");
    assert.ok(vit.text.includes("124"), "vitals reading visible");
    const acc = await get(`/doctor/emr/patients/${S.pat.id}/access`, { token: S.docA.token });
    const by = Object.fromEntries(acc.data.categories.map((c) => [c.category, c]));
    for (const c of ["medical_history", "consultations", "diagnoses", "doctor_notes", "vitals"]) assert.equal(by[c].status, "open", c);
    for (const c of ["medications", "investigations"]) assert.equal(by[c].granted, false, `${c} locked`);
  });

  it("documents: only the one the doctor filed — no patient upload, no identity document", async () => {
    const res = await docs("docA");
    expectStatus(res, 200, "documents");
    assert.deepEqual(titles(res), [`RX-OWN-${RUN}`]);
    assert.equal(res.data[0].access.via, "own");
    for (const t of [...PRIVATE, T.aadhaar, T.other]) assert.ok(!res.text.includes(t), `leaked ${t}`);
    assert.ok(!res.text.includes("4321"), "no ID digits");
  });

  it("a doctor who does not treat the patient gets nothing", async () => {
    expectStatus(await docs("docB"), 404, "non-treating doctor");
    expectStatus(await get(`/doctor/emr/patients/${S.patQ.id}/documents`, { token: S.docA.token }), 404, "another patient");
    expectStatus(await get(`/doctor/emr/patients/${S.pat.id}/documents`, { token: S.pat.token }), 403, "patient token on doctor route");
  });
});

describe("3. Consent: pending, approve one category, reject, revoke", () => {
  it("a pending request exposes nothing, and the patient is notified", async () => {
    const res = await post(`/doctor/emr/patients/${S.pat.id}/access-requests`, {
      token: S.docA.token,
      body: { categories: ["medications"], purpose: "Reviewing earlier prescriptions" },
    });
    expectStatus(res, 201, "request medications");
    const cat = res.data.categories.find((c) => c.category === "medications");
    assert.equal(cat.status, "pending");
    S.reqMeds = cat.requestId;
    assert.ok(S.reqMeds, "request id returned");
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.pat.id, type: "record_access_requested" } }), "patient notified");
    const d = await docs("docA");
    for (const t of PRIVATE) assert.ok(!d.text.includes(t), `pending leaked ${t}`);
  });

  it("approving prescriptions exposes the prescription ONLY — with its metadata and a working file link", async () => {
    expectStatus(await post(`/patient/access-requests/${S.reqMeds}/approve`, { token: S.pat.token, body: { durationDays: 7 } }), 200, "approve");
    const d = await docs("docA");
    const rx = d.data.find((x) => x.tag === T.rx);
    assert.ok(rx, "prescription visible");
    assert.deepEqual(rx.access, { via: "category", category: "medications" });
    assert.equal(rx.documentKind, "prescription");
    assert.equal(rx.recordDate, ist(-10));
    assert.equal(rx.location, "City Hospital");
    assert.equal(rx.doctorName, "Dr. Outside");
    assert.equal(rx.originalName, "rx.pdf");
    assert.equal(rx.mimeType, "application/pdf");
    assert.ok(rx.uploadedAt);
    assert.equal(rx.idLast4, undefined, "no ID field for doctors");
    const file = await fetch(rx.fileUrl);
    assert.equal(file.status, 200, "signed link opens");
    for (const t of [T.blood, T.xray, T.ct, T.ecg, T.discharge, T.cert, T.aadhaar]) assert.ok(!d.text.includes(t), `medications grant leaked ${t}`);
  });

  it("the booking snapshot follows the same rules (no bypass)", async () => {
    const b = await get(`/doctor/bookings/${S.bookingA}`, { token: S.docA.token });
    expectStatus(b, 200, "booking");
    assert.ok(b.text.includes(T.rx), "approved prescription in snapshot");
    for (const t of [T.blood, T.xray, T.ct, T.discharge, T.aadhaar]) assert.ok(!b.text.includes(t), `snapshot leaked ${t}`);
  });

  it("a rejected request keeps tests, scans and other documents private", async () => {
    const res = await post(`/doctor/emr/patients/${S.pat.id}/access-requests`, {
      token: S.docA.token,
      body: { categories: ["investigations"], purpose: "Reviewing earlier reports and scans" },
    });
    expectStatus(res, 201, "request investigations");
    S.reqTests = res.data.categories.find((c) => c.category === "investigations").requestId;
    expectStatus(await post(`/patient/access-requests/${S.reqTests}/reject`, { token: S.pat.token, body: {} }), 200, "reject");
    const d = await docs("docA");
    for (const t of [T.blood, T.xray, T.ct, T.ecg, T.discharge, T.cert]) assert.ok(!d.text.includes(t), `rejected leaked ${t}`);
    const acc = await get(`/doctor/emr/patients/${S.pat.id}/access`, { token: S.docA.token });
    assert.equal(acc.data.categories.find((c) => c.category === "investigations").status, "rejected");
  });

  it("revoking the prescriptions grant hides them again on the next request", async () => {
    expectStatus(await post(`/patient/access-requests/${S.reqMeds}/revoke`, { token: S.pat.token, body: {} }), 200, "revoke");
    const d = await docs("docA");
    assert.ok(!d.text.includes(T.rx), "revoked prescription hidden");
    assert.deepEqual(titles(d), [`RX-OWN-${RUN}`]);
  });

  it("approving tests & reports (another doctor) exposes reports, imaging, ECG, discharge, certificate — never identity", async () => {
    await makeBooking(S.docC.id, S.pat.id, { day: ist(0), status: "confirmed" });
    const res = await post(`/doctor/emr/patients/${S.pat.id}/access-requests`, {
      token: S.docC.token,
      body: { categories: ["investigations"], purpose: "Reviewing earlier reports and scans" },
    });
    expectStatus(res, 201, "C requests investigations");
    const id = res.data.categories.find((c) => c.category === "investigations").requestId;
    expectStatus(await post(`/patient/access-requests/${id}/approve`, { token: S.pat.token, body: { durationDays: 7 } }), 200, "approve C");
    const d = await docs("docC");
    for (const t of [T.blood, T.xray, T.ct, T.ecg, T.discharge, T.cert]) assert.ok(d.text.includes(t), `C sees ${t}`);
    assert.ok(!d.text.includes(T.rx), "prescriptions still need their own grant");
    assert.ok(!d.text.includes(T.aadhaar) && !d.text.includes("4321"), "identity never shared");
    assert.ok(!d.text.includes(T.other), "another patient's document never shown");
    assert.ok(d.data.every((x) => x.access.via === "category" && x.access.category === "investigations"));
    // Doctor A's rejection is untouched by C's approval.
    const a = await docs("docA");
    assert.ok(!a.text.includes(T.blood), "approval for C does not open A");
  });
});

describe("4. A document shared one-by-one (migration 045)", () => {
  it("is listed stream-only and readable through the audited endpoint", async () => {
    // Doctor B does not treat the patient yet: asks for X-rays through the document request.
    const req = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.pat.id, category: "xray", purpose: "Second opinion on the chest X-ray" },
    });
    expectStatus(req, 201, "document request");
    expectStatus(
      await post(`/patient/access-requests/${req.data.id}/approve`, { token: S.pat.token, body: { recordIds: [S.xray.id], durationDays: 7 } }),
      200,
      "approve one X-ray"
    );
    // Then B becomes a treating doctor and opens the workbench.
    await makeBooking(S.docB.id, S.pat.id, { day: ist(0), status: "confirmed" });
    const d = await docs("docB");
    expectStatus(d, 200, "B documents");
    const x = d.data.find((r) => r.tag === T.xray);
    assert.ok(x, "shared X-ray listed");
    assert.equal(x.access.via, "document");
    assert.equal(x.fileUrl, null, "no file link for a document-level share");
    for (const t of [T.ct, T.blood, T.rx, T.aadhaar]) assert.ok(!d.text.includes(t), `B leaked ${t}`);
    const file = await get(`/doctor/access-requests/${x.access.requestId}/records/${x.id}/file`, { token: S.docB.token });
    expectStatus(file, 200, "stream");
    assert.ok(file.raw.subarray(0, 4).equals(PNG.subarray(0, 4)), "the real file bytes");
    const ct = await get(`/doctor/access-requests/${x.access.requestId}/records/${S.ct.id}/file`, { token: S.docB.token });
    assert.equal(ct.status, 403, "a document outside the grant is refused");
  });
});
