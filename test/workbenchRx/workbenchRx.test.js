/**
 * Workbench → prescription, shared medicine catalogue, admin ICD master and
 * Previous Consultations (migration 059) — end-to-end API tests.
 *
 * Real HTTP, real database, no mocks. Cast: doctor A ("Dr. Puspak" role),
 * doctor B ("Dr. Soumya" role), patient P (treated by both) and patient Q.
 *
 *  C. Admin ICD master: add, duplicate refused per system+version, role gate,
 *     doctor search by name / code (with and without the dot), deactivate,
 *     add-only import (dry run, then real), usage count.
 *  B. Shared catalogue: A adds a medicine, B finds it, B's copy links to the
 *     SAME catalogue row, other strengths / forms stay separate, own-list
 *     duplicate refused, pharmacy inventory untouched.
 *  A. Workbench → prescription: vitals + complaint + examination + coded
 *     diagnosis + hidden diagnosis + follow-up → the draft opens filled;
 *     double / concurrent create gives ONE prescription; refresh picks up later
 *     Workbench changes without writing to them; finalize freezes the snapshot;
 *     the patient sees it (without the hidden diagnosis), another patient does
 *     not; the PDF renders.
 *  D. Previous Consultations: newest first, each visit with its own vitals,
 *     diagnosis + ICD and medicines; another doctor's medicines stay locked.
 *
 * Run against an already-running API (writes tagged test data into THAT
 * server's database; accounts, test catalogue rows and ICD rows are
 * deactivated at the end):
 *   PORT=5071 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 node src/server.js
 *   WORKBENCH_RX_E2E_BASE_URL=http://127.0.0.1:5071 node --test test/workbenchRx/workbenchRx.test.js
 */
const path = require("path");

const EXTERNAL = process.env.WORKBENCH_RX_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Op } = require("sequelize");

const {
  sequelize,
  User,
  Booking,
  ClinicalEntry,
  Prescription,
  IcdCode,
  MedicineMaster,
  MedicineStoreMedicine,
} = require("../../src/models");
const passwordUtil = require("../../src/utils/password");

const RUN = Date.now().toString(36);
const PASSWORD = "Workbench#2026x";
const ICD_VERSION = `E2E-${RUN}`; // an isolated test catalogue version, deactivated at the end
const MED = `Zerodol${RUN}`;
let server;
let base;
const S = { bookings: [] };

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
  return { status: res.status, body: json, data: json?.data, text, headers: res.headers };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);
const patch = (p, o) => call("PATCH", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${res.text?.slice(0, 600)}`);
}

const email = (who) => `wbrx-${who}-${RUN}@ihs-test.example.com`;
const ist = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));

async function makeUser(who, role, extra = {}) {
  const hash = await passwordUtil.hash(PASSWORD);
  const [cols] = await sequelize.query("SHOW COLUMNS FROM users");
  const names = new Set(cols.map((c) => c.Field));
  const row = { role, name: `${who} Wbrx${RUN}`, email: email(who), password_hash: hash, is_active: 1, is_email_verified: 1, ...extra };
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

async function makeBooking(doctor, patient, { day, status = "confirmed", start = "10:00:00" }) {
  const b = await Booking.create({
    patientId: patient,
    doctorId: doctor,
    bookingType: "offline",
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

const item = (name, extra = {}) => ({
  medicineName: name,
  dosage: "1 tab",
  route: "oral",
  frequency: "BD",
  timing: "after_food",
  durationDays: 5,
  durationUnit: "day",
  notes: null,
  ...extra,
});

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  for (const key of ["docA", "docB"]) {
    S[key] = { id: await makeUser(key, "doctor") };
    await sequelize.query("INSERT INTO doctor_profiles (user_id, registration_number, verification_status) VALUES (?, ?, 'approved')", {
      replacements: [S[key].id, `REG-WBRX-${key}-${RUN}`],
    });
  }
  S.pat = { id: await makeUser("pat", "patient", { phone: "9876501234" }) };
  await sequelize.query(
    "INSERT INTO patient_profiles (user_id, date_of_birth, gender, blood_group, address_line, city) VALUES (?, '1988-04-12', 'female', 'B+', '12 Temple Rd', 'Cuttack')",
    { replacements: [S.pat.id] }
  );
  S.patQ = { id: await makeUser("patQ", "patient") };
  await sequelize.query("INSERT INTO patient_profiles (user_id) VALUES (?)", { replacements: [S.patQ.id] });

  S.docA.token = await login("docA", "doctor");
  S.docB.token = await login("docB", "doctor");
  S.pat.token = await login("pat", "patient");
  S.patQ.token = await login("patQ", "patient");

  const admin = await post("/auth/admin/login", { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  expectStatus(admin, 200, "admin login");
  S.adminToken = admin.data.tokens.accessToken;

  // Visits: A five days ago (completed later), B two days ago, A today.
  S.b0 = await makeBooking(S.docA.id, S.pat.id, { day: ist(-5), start: "09:00:00" });
  S.b2 = await makeBooking(S.docB.id, S.pat.id, { day: ist(-2), start: "11:00:00" });
  S.b1 = await makeBooking(S.docA.id, S.pat.id, { day: ist(0), start: "10:00:00" });
  S.bRace = await makeBooking(S.docA.id, S.patQ.id, { day: ist(0), start: "12:00:00" });
});

after(async () => {
  if (EXTERNAL) {
    const ids = [S.docA?.id, S.docB?.id, S.pat?.id, S.patQ?.id].filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
    if (S.bookings.length) await Booking.update({ status: "cancelled" }, { where: { id: S.bookings, status: { [Op.ne]: "completed" } } });
    await IcdCode.update({ isActive: false }, { where: { systemVersion: ICD_VERSION } });
    await MedicineMaster.update({ isActive: false }, { where: { medicineName: { [Op.like]: `%${RUN}%` } } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("C. Admin ICD code master", () => {
  it("admin adds a code; a duplicate in the same system + version is refused, another version is not", async () => {
    const body = { codingSystem: "ICD-10", systemVersion: ICD_VERSION, code: "m54.5", title: "Low back pain", description: "Low back pain", category: "Dorsopathies" };
    const res = await post("/admin/icd-codes", { token: S.adminToken, body });
    expectStatus(res, 201, "create ICD");
    assert.equal(res.data.code, "M54.5", "stored upper-case");
    S.icd = res.data;

    const dup = await post("/admin/icd-codes", { token: S.adminToken, body: { ...body, code: "M54.5 " } });
    expectStatus(dup, 409, "duplicate");
    assert.equal(dup.body.error.code, "ICD_DUPLICATE");
    assert.equal(dup.body.error.details.id, S.icd.id);

    const other = await post("/admin/icd-codes", { token: S.adminToken, body: { ...body, systemVersion: `${ICD_VERSION}b` } });
    expectStatus(other, 201, "same code, other version");
    await patch(`/admin/icd-codes/${other.data.id}`, { token: S.adminToken, body: { isActive: false } });
    await IcdCode.update({ isActive: false }, { where: { id: other.data.id } });
  });

  it("a doctor cannot manage the master", async () => {
    expectStatus(await get("/admin/icd-codes", { token: S.docA.token }), 403, "doctor list");
    expectStatus(await post("/admin/icd-codes", { token: S.docA.token, body: { codingSystem: "ICD-10", systemVersion: "x", code: "A00", title: "Cholera" } }), 403, "doctor create");
  });

  it("doctors find it by diagnosis name and by code (with or without the dot)", async () => {
    for (const q of ["low back pain", "M54.5", "m545", "Low back"]) {
      const res = await get(`/doctor/emr/search/icd?q=${encodeURIComponent(q)}`, { token: S.docA.token });
      expectStatus(res, 200, `search ${q}`);
      const hit = res.data.find((r) => r.id === S.icd.id);
      assert.ok(hit, `"${q}" finds the row`);
      assert.equal(hit.codingSystem, "ICD-10");
      assert.equal(hit.systemVersion, ICD_VERSION);
    }
  });

  it("a deactivated row disappears from doctor search; reactivating brings it back", async () => {
    expectStatus(await patch(`/admin/icd-codes/${S.icd.id}`, { token: S.adminToken, body: { isActive: false } }), 200, "deactivate");
    let res = await get("/doctor/emr/search/icd?q=m545", { token: S.docA.token });
    assert.ok(!res.data.some((r) => r.id === S.icd.id));
    expectStatus(await patch(`/admin/icd-codes/${S.icd.id}`, { token: S.adminToken, body: { isActive: true } }), 200, "reactivate");
    res = await get("/doctor/emr/search/icd?q=m545", { token: S.docA.token });
    assert.ok(res.data.some((r) => r.id === S.icd.id));
  });

  it("import is add-only: a dry run writes nothing, existing codes are skipped, never overwritten", async () => {
    const rows = [
      { code: "M54.5", title: "SHOULD NOT OVERWRITE" },
      { code: "G44.2", title: "Tension-type headache" },
      { code: "g44.2", title: "Tension-type headache (repeat)" },
    ];
    const dry = await post("/admin/icd-codes/import", { token: S.adminToken, body: { codingSystem: "ICD-10", systemVersion: ICD_VERSION, dryRun: true, rows } });
    expectStatus(dry, 200, "dry run");
    assert.equal(dry.data.wouldInsert, 1);
    assert.equal(dry.data.inserted, 0);
    assert.deepEqual(dry.data.skippedExisting, ["M54.5"]);
    assert.deepEqual(dry.data.duplicatesInFile, ["G44.2"]);
    assert.equal(await IcdCode.count({ where: { systemVersion: ICD_VERSION, code: "G44.2" } }), 0, "dry run wrote nothing");

    const real = await post("/admin/icd-codes/import", { token: S.adminToken, body: { codingSystem: "ICD-10", systemVersion: ICD_VERSION, rows } });
    expectStatus(real, 200, "import");
    assert.equal(real.data.inserted, 1);
    const kept = await IcdCode.findByPk(S.icd.id);
    assert.equal(kept.title, "Low back pain", "existing row untouched");

    const again = await post("/admin/icd-codes/import", { token: S.adminToken, body: { codingSystem: "ICD-10", systemVersion: ICD_VERSION, rows } });
    assert.equal(again.data.inserted, 0, "re-import is a no-op");

    const list = await get(`/admin/icd-codes?codingSystem=ICD-10&systemVersion=${ICD_VERSION}`, { token: S.adminToken });
    expectStatus(list, 200, "admin list");
    assert.deepEqual(list.data.rows.map((r) => r.code).sort(), ["G44.2", "M54.5"]);
    const meta = await get("/admin/icd-codes/meta", { token: S.adminToken });
    assert.ok(meta.data.versions.some((v) => v.systemVersion === ICD_VERSION && v.total === 2));
  });
});

describe("B. Shared medicine catalogue across doctors", () => {
  it("doctor A adds a medicine — it joins the shared catalogue", async () => {
    const res = await post("/doctor/medicines", {
      token: S.docA.token,
      body: { name: MED, genericName: "Aceclofenac", strength: "100 mg", dosageForm: "tablet", form: "oral" },
    });
    expectStatus(res, 201, "A adds");
    assert.ok(res.data.medicineMasterId, "linked to the catalogue");
    S.master100 = String(res.data.medicineMasterId);
  });

  it("doctor B finds it by brand and by generic + strength without creating it", async () => {
    for (const q of [MED, `${MED.toLowerCase()} 100`, `${MED} tablet`]) {
      const res = await get(`/doctor/emr/search/medicines?q=${encodeURIComponent(q)}`, { token: S.docB.token });
      expectStatus(res, 200, `B search ${q}`);
      const hit = res.data.find((h) => h.source === "catalogue" && h.catalogueId === S.master100);
      assert.ok(hit, `"${q}" finds A's medicine in the catalogue`);
      assert.equal(hit.strength, "100 mg");
      assert.equal(hit.dosageForm, "tablet");
      assert.equal(hit.genericName, "Aceclofenac");
    }
  });

  it("B adding the same medicine (other casing / spacing) reuses A's catalogue row", async () => {
    const res = await post("/doctor/medicines", {
      token: S.docB.token,
      body: { name: MED.toUpperCase(), strength: "100MG", dosageForm: "tablet", form: "oral" },
    });
    expectStatus(res, 201, "B adds same");
    assert.equal(String(res.data.medicineMasterId), S.master100, "no second catalogue row");
    assert.equal(await MedicineMaster.count({ where: { medicineName: { [Op.like]: `%${RUN}%` }, strength: { [Op.like]: "100%" }, medicineType: "tablet" } }), 1);
  });

  it("a different strength or dosage form stays a separate medicine", async () => {
    const s200 = await post("/doctor/medicines", { token: S.docB.token, body: { name: MED, strength: "200 mg", dosageForm: "tablet", form: "oral" } });
    expectStatus(s200, 201, "200 mg");
    const gel = await post("/doctor/medicines", { token: S.docB.token, body: { name: MED, strength: "100 mg", dosageForm: "gel", form: "topical" } });
    expectStatus(gel, 201, "100 mg gel");
    const ids = new Set([S.master100, String(s200.data.medicineMasterId), String(gel.data.medicineMasterId)]);
    assert.equal(ids.size, 3, "three distinct catalogue rows");
  });

  it("re-adding to one's own list is refused as a duplicate", async () => {
    const res = await post("/doctor/medicines", { token: S.docA.token, body: { name: ` ${MED.toLowerCase()} `, strength: "100 mg", dosageForm: "tablet", form: "oral" } });
    expectStatus(res, 409, "own duplicate");
    assert.equal(res.body.error.code, "MEDICINE_DUPLICATE");
  });

  it("adding to the catalogue never creates pharmacy stock", async () => {
    const masters = (await MedicineMaster.findAll({ where: { medicineName: { [Op.like]: `%${RUN}%` } }, attributes: ["id"] })).map((m) => m.id);
    assert.equal(await MedicineStoreMedicine.count({ where: { medicineMasterId: masters } }), 0);
  });
});

describe("A. Workbench → prescription", () => {
  it("the doctor records the consultation in the Workbench", async () => {
    const t = S.docA.token;
    const v = await post(`/doctor/emr/bookings/${S.b1}/vitals`, {
      token: t,
      body: { bpSystolic: 128, bpDiastolic: 82, pulseRateBpm: 76, heartRateBpm: 78, respiratoryRate: 16, spo2Percent: 98, temperatureF: 98.4, heightCm: 160, weightKg: 64 },
    });
    expectStatus(v, 201, "vitals");
    S.complaint = await entry(t, S.b1, { kind: "complaint", title: `Low back pain ${RUN}`, details: { duration: 3, durationUnit: "day", severity: "moderate" } });
    await entry(t, S.b1, { kind: "examination", category: "general", details: { build: "Average" }, remarks: "Tender L4-L5" });
    S.dx = await entry(t, S.b1, { kind: "diagnosis", title: "Low back pain", code: "WRONG1", icdCodeId: S.icd.id, category: "provisional" });
    assert.equal(S.dx.code, "M54.5", "the code comes from the catalogue row, not the client");
    assert.equal(S.dx.codeSystem, "ICD-10");
    assert.equal(S.dx.codeVersion, ICD_VERSION);
    assert.equal(S.dx.icdCodeId, S.icd.id);
    await entry(t, S.b1, { kind: "diagnosis", title: `Private differential ${RUN}`, category: "differential", patientVisible: false });

    const statuses = await get("/doctor/follow-up-statuses", { token: t });
    expectStatus(statuses, 200, "follow-up statuses");
    S.followUpOn = ist(14);
    const fu = await put(`/doctor/bookings/${S.b1}/follow-up`, { token: t, body: { statusId: String(statuses.data[0].id), followUpOn: S.followUpOn, note: "Review" } });
    assert.ok([200, 201].includes(fu.status), `follow-up: ${fu.status} ${fu.text.slice(0, 300)}`);
  });

  it("opening the prescription fills it from the Workbench — no second patient / consultation form", async () => {
    const res = await post("/doctor/prescriptions", { token: S.docA.token, body: { bookingId: S.b1 } });
    expectStatus(res, 201, "create draft");
    const rx = res.data;
    S.rx = rx;
    const snap = rx.clinicalSnapshot;
    assert.ok(snap, "snapshot attached");
    assert.equal(rx.patient.id, String(S.pat.id));
    assert.match(rx.patient.regNo, /^IHS-P-\d{6}$/);
    assert.equal(snap.patient.regNo, rx.patient.regNo);
    assert.equal(snap.patient.bloodGroup, "B+");
    assert.equal(snap.patient.gender, "female");
    assert.equal(snap.patient.dateOfBirth, "1988-04-12");
    assert.equal(snap.patient.phone, "9876501234");
    assert.match(snap.patient.address, /Temple Rd/);
    assert.equal(snap.consultation.bookingId, S.b1);
    assert.equal(snap.consultation.appointmentType, "clinic");
    assert.equal(snap.vitals.source, "consultation");
    assert.equal(snap.vitals.values.bloodPressure, "128/82");
    assert.equal(snap.vitals.values.respiratoryRate, 16);
    assert.equal(snap.vitals.values.bmi, 25);
    assert.equal(snap.examinations.length, 1);
    assert.equal(rx.chiefComplaint, `1. Low back pain ${RUN} — since 3 days, moderate`);
    assert.equal(rx.diagnosis, "1. Low back pain (ICD-10 M54.5) — provisional");
    assert.ok(!rx.diagnosis.includes("Private"), "hidden diagnosis not printed");
    assert.equal(snap.diagnoses.length, 2, "the doctor still sees both");
    assert.equal(rx.vitals.bloodPressure, "128/82");
    assert.equal(rx.vitals.pulseRateBpm, 76);
    assert.equal(Number(rx.vitals.weightKg), 64);
    assert.equal(rx.followUpDate, S.followUpOn);
  });

  it("a second open / double submit lands on the SAME prescription", async () => {
    const again = await post("/doctor/prescriptions", { token: S.docA.token, body: { bookingId: S.b1 } });
    expectStatus(again, 409, "second create");
    assert.equal(again.body.error.code, "RX_ALREADY_EXISTS");
    assert.equal(again.body.error.details.prescriptionId, S.rx.id);

    const race = await Promise.all([1, 2, 3].map(() => post("/doctor/prescriptions", { token: S.docA.token, body: { bookingId: S.bRace } })));
    assert.equal(race.filter((r) => r.status === 201).length, 1, `exactly one created: ${race.map((r) => r.status)}`);
    assert.ok(race.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await Prescription.count({ where: { bookingId: S.bRace } }), 1);
  });

  it("medicines from the shared catalogue are prescribed with their own instructions", async () => {
    const res = await patch(`/doctor/prescriptions/${S.rx.id}`, {
      token: S.docA.token,
      body: {
        items: [
          item(`${MED} 100 mg`, { medicineMasterId: S.master100, strength: "100 mg", dosageForm: "tablet", quantity: 10 }),
          item(`Pan40${RUN}`, { frequency: "OD", timing: "before_food", durationDays: 7 }),
        ],
        advice: "1. Hot fomentation",
      },
    });
    expectStatus(res, 200, "items");
    assert.equal(res.data.items.length, 2);
    assert.equal(res.data.items[0].medicineMasterId, S.master100);
  });

  it("refresh picks up later Workbench changes and never writes to the Workbench", async () => {
    await entry(S.docA.token, S.b1, { kind: "complaint", title: `Leg tingling ${RUN}` });
    const before = await ClinicalEntry.count({ where: { bookingId: S.b1 } });
    const res = await post(`/doctor/prescriptions/${S.rx.id}/sync-workbench`, { token: S.docA.token });
    expectStatus(res, 200, "sync");
    assert.match(res.data.chiefComplaint, /2\. Leg tingling/);
    assert.equal(res.data.items.length, 2, "medicines untouched");
    assert.equal(res.data.advice, "1. Hot fomentation", "doctor-only fields untouched");
    assert.equal(await ClinicalEntry.count({ where: { bookingId: S.b1 } }), before, "Workbench unchanged");
    expectStatus(await post(`/doctor/prescriptions/${S.rx.id}/sync-workbench`, { token: S.docB.token }), 404, "another doctor cannot sync it");
  });

  it("finalize links it to the right patient / doctor / consultation and freezes the snapshot", async () => {
    const res = await post(`/doctor/prescriptions/${S.rx.id}/finalize`, { token: S.docA.token, body: { emailPatient: false } });
    expectStatus(res, 200, "finalize");
    assert.equal(res.data.status, "finalized");
    assert.ok(res.data.rxNumber);
    S.rxNumber = res.data.rxNumber;
    const row = await Prescription.findByPk(S.rx.id);
    assert.equal(String(row.bookingId), S.b1);
    assert.equal(String(row.patientId), String(S.pat.id));
    assert.equal(String(row.doctorId), String(S.docA.id));
    assert.equal(row.clinicalSnapshot.complaints.length, 2);

    const twice = await post(`/doctor/prescriptions/${S.rx.id}/finalize`, { token: S.docA.token, body: {} });
    expectStatus(twice, 200, "finalize again");
    assert.equal(twice.data.rxNumber, S.rxNumber, "idempotent — one number");

    // A later Workbench change does not rewrite the signed prescription.
    await entry(S.docA.token, S.b1, { kind: "complaint", title: `After signing ${RUN}` });
    const after = await get(`/doctor/prescriptions/${S.rx.id}`, { token: S.docA.token });
    assert.equal(after.data.clinicalSnapshot.complaints.length, 2);
    assert.ok(!after.data.chiefComplaint.includes("After signing"));
    expectStatus(await post(`/doctor/prescriptions/${S.rx.id}/sync-workbench`, { token: S.docA.token }), 409, "no sync after signing");
  });

  it("the patient sees it (without the hidden diagnosis or the doctor's snapshot); another patient does not", async () => {
    const mine = await get("/patient/prescriptions", { token: S.pat.token });
    expectStatus(mine, 200, "patient list");
    const rx = mine.data.find((r) => String(r.id) === S.rx.id);
    assert.ok(rx, "patient sees the signed prescription");
    assert.ok(!mine.text.includes("Private differential"), "hidden diagnosis never reaches the patient");
    assert.ok(!mine.text.includes("clinicalSnapshot"));
    const other = await get("/patient/prescriptions", { token: S.patQ.token });
    assert.ok(!other.data.some((r) => String(r.id) === S.rx.id));
    expectStatus(await get(`/patient/prescriptions/${S.rx.id}`, { token: S.patQ.token }), 404, "Q cannot open P's prescription");
  });

  it("the prescription PDF renders from the existing letterhead", async () => {
    const res = await get(`/doctor/prescriptions/${S.rx.id}/pdf`, { token: S.docA.token });
    assert.ok([200, 302].includes(res.status), `pdf: ${res.status} ${res.text.slice(0, 300)}`);
  });
});

describe("D. Previous Consultations", () => {
  it("setup: an older visit of A with its own prescription, and B's visit with a diagnosis", async () => {
    const t = S.docA.token;
    await post(`/doctor/emr/bookings/${S.b0}/vitals`, { token: t, body: { bpSystolic: 140, bpDiastolic: 90, weightKg: 66 } });
    await entry(t, S.b0, { kind: "complaint", title: `Knee pain ${RUN}` });
    await entry(t, S.b0, { kind: "diagnosis", title: `Osteoarthritis knee ${RUN}`, category: "final", code: "M17.9" });
    const rx0 = await post("/doctor/prescriptions", { token: t, body: { bookingId: S.b0 } });
    expectStatus(rx0, 201, "rx0");
    S.rx0 = rx0.data.id;
    await patch(`/doctor/prescriptions/${S.rx0}`, { token: t, body: { items: [item(`Paracet${RUN}`)] } });
    expectStatus(await post(`/doctor/prescriptions/${S.rx0}/finalize`, { token: t, body: {} }), 200, "finalize rx0");

    await entry(S.docB.token, S.b2, { kind: "diagnosis", title: `Lumbar strain ${RUN}`, category: "final", icdCodeId: S.icd.id });
    const rxB = await post("/doctor/prescriptions", { token: S.docB.token, body: { bookingId: S.b2 } });
    await patch(`/doctor/prescriptions/${rxB.data.id}`, { token: S.docB.token, body: { items: [item(`SecretMed${RUN}`)] } });
    expectStatus(await post(`/doctor/prescriptions/${rxB.data.id}/finalize`, { token: S.docB.token, body: {} }), 200, "finalize B");

    await Booking.update({ status: "completed" }, { where: { id: [S.b0, S.b2, S.b1] } });
  });

  it("newest first; each visit shows only its own vitals, diagnosis + ICD and medicines", async () => {
    const res = await get(`/doctor/emr/patients/${S.pat.id}/history`, { token: S.docA.token });
    expectStatus(res, 200, "history");
    const visits = res.data.consultations.map((c) => c.visit.bookingId);
    assert.deepEqual(visits.filter((id) => [S.b0, S.b1, S.b2].includes(id)), [S.b1, S.b2, S.b0], "newest first");
    const byId = Object.fromEntries(res.data.consultations.map((c) => [c.visit.bookingId, c]));

    const today = byId[S.b1];
    const coded = today.diagnoses.find((d) => d.icdCodeId === S.icd.id);
    assert.equal(coded.code, "M54.5");
    assert.equal(coded.codeSystem, "ICD-10");
    assert.equal(today.vitals[0].values.bloodPressure, "128/82");
    assert.deepEqual(today.prescription.items.map((i) => i.medicineName).sort(), [`${MED} 100 mg`, `Pan40${RUN}`].sort());

    const older = byId[S.b0];
    assert.equal(older.vitals[0].values.bloodPressure, "140/90");
    assert.deepEqual(older.prescription.items.map((i) => i.medicineName), [`Paracet${RUN}`]);
    assert.equal(older.diagnoses[0].code, "M17.9");
    assert.equal(older.diagnoses[0].icdCodeId, null, "typed by hand, not linked");

    // Doctor B's visit: the diagnosis is common information; the medicines need the patient's grant.
    const bVisit = byId[S.b2];
    assert.equal(bVisit.diagnoses[0].code, "M54.5");
    assert.equal(bVisit.prescription, null);
    assert.ok(bVisit.locked.includes("medications"));
    assert.ok(!res.text.includes(`SecretMed${RUN}`), "B's medicines never reach A");
  });

  it("the patient's own history shows ICD codes but only what was shown to them", async () => {
    const res = await get("/patient/medical-history", { token: S.pat.token });
    expectStatus(res, 200, "patient history");
    const today = res.data.consultations.find((c) => c.visit.bookingId === S.b1);
    assert.ok(today.diagnoses.some((d) => d.code === "M54.5" && d.codeSystem === "ICD-10"));
    assert.ok(!res.text.includes("Private differential"));
    assert.ok(res.data.diagnoses.some((d) => d.code === "M54.5"), "diagnosis history carries the code");
  });

  it("the admin list counts how many diagnoses used the code", async () => {
    const list = await get(`/admin/icd-codes?codingSystem=ICD-10&systemVersion=${ICD_VERSION}&q=M54.5`, { token: S.adminToken });
    const row = list.data.rows.find((r) => r.id === S.icd.id);
    assert.equal(row.usedCount, 2, "A's and B's coded diagnoses");
  });
});
