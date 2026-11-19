/**
 * Medicine management (migration 055) — end-to-end API tests.
 *
 * Real HTTP + a real Socket.IO connection, no mocks:
 *  - doctor My Medicines: new fields, catalogue link (no admin approval), duplicates refused;
 *  - prescription → patient sync: drafts never sync, finalize syncs once (idempotent),
 *    strength kept apart from the prescribed dose, amendment supersedes safely;
 *  - patient own medicines: multi-medicine cart in one request, independent schedules,
 *    idempotent retries, never written to the shared catalogue;
 *  - doses: taken / skip / snooze rules, idempotency, audit events, missed sweep,
 *    due reminders (once, privacy mode), real-time push to the patient's other apps;
 *  - routines: pause / resume / stop, prescribed fields locked, completion sweep;
 *  - security: another patient / a doctor / anonymous can't reach a patient's medicines.
 *
 * Run against an already-running API (writes tagged test data into THAT
 * server's database; the run's accounts are deactivated at the end):
 *   PORT=5055 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 node src/server.js
 *   MEDICINE_E2E_BASE_URL=http://localhost:5055 node --test test/patientMedicine/patientMedicine.test.js
 *
 * Accounts are inserted directly (not via /auth/register) because the local
 * users table may carry extra NOT NULL columns from another app; they sign in
 * through the real /auth/login.
 */
const path = require("path");

const EXTERNAL = process.env.MEDICINE_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { io: ioClient } = require("socket.io-client");

const {
  sequelize,
  User,
  Booking,
  MedicineMaster,
  MedicineDoseLog,
  MedicineDoseEvent,
  MedicineNotification,
  PatientMedicine,
} = require("../../src/models");
const passwordUtil = require("../../src/utils/password");
const sched = require("../../src/utils/medicineSchedule");
const patientMedicine = require("../../src/services/patientMedicine.service");
const reminderSweep = require("../../src/services/medicineReminder.service");

const RUN = Date.now().toString(36);
const PASSWORD = "MedRout#2026x";
const TZ = "Asia/Kolkata";
let server;
let base;
const S = {};

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
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);
const patch = (p, o) => call("PATCH", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

const email = (who) => `medrout-${who}-${RUN}@ihs-test.example.com`;
const todayLocal = () => sched.localDate(new Date(), TZ);
/** Local HH:MM in TZ, `min` minutes from now. */
function clockIn(min) {
  const d = new Date(Date.now() + min * 60_000);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return p;
}

/** Insert a user directly (fills any extra NOT NULL columns another app added). */
async function makeUser(who, role) {
  const hash = await passwordUtil.hash(PASSWORD);
  const [cols] = await sequelize.query("SHOW COLUMNS FROM users");
  const names = new Set(cols.map((c) => c.Field));
  const row = { role, name: `${who} Med${RUN}`, email: email(who), password_hash: hash, is_active: 1, is_email_verified: 1 };
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

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, { path: "/socket.io", transports: ["websocket"], auth: { token }, reconnection: false });
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    socket.once("ready", () => resolve({ socket, events }));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}
const waitFor = async (predicate, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
};

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    const app = require("../../src/app");
    const realtime = require("../../src/realtime/socket");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    realtime.init(server);
    base = `http://127.0.0.1:${server.address().port}`;
  }

  S.doc = { id: await makeUser("doc", "doctor") };
  await sequelize.query(
    "INSERT INTO doctor_profiles (user_id, registration_number, verification_status) VALUES (?, ?, 'approved')",
    { replacements: [S.doc.id, `REG-MED-${RUN}`] }
  );
  for (const key of ["patA", "patB"]) {
    S[key] = { id: await makeUser(key, "patient") };
    await sequelize.query("INSERT INTO patient_profiles (user_id) VALUES (?)", { replacements: [S[key].id] });
  }
  const booking = await Booking.create({
    patientId: S.patA.id,
    doctorId: S.doc.id,
    bookingType: "online",
    slotDate: todayLocal(),
    slotStartTime: "10:00:00",
    slotEndTime: "10:15:00",
    paymentMode: "online",
    amount: 0,
    status: "confirmed",
  });
  S.bookingId = String(booking.id);

  S.doc.token = await login("doc", "doctor");
  S.patA.token = await login("patA", "patient");
  S.patB.token = await login("patB", "patient");
});

after(async () => {
  S.sock?.socket?.close();
  const ids = [S.doc?.id, S.patA?.id, S.patB?.id].filter(Boolean);
  if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  if (S.bookingId) await Booking.update({ status: "cancelled" }, { where: { id: S.bookingId } }).catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

// ── Doctor My Medicines ─────────────────────────────────────────────────────
describe("Doctor My Medicines", () => {
  it("adds a medicine with the new fields and links it to the shared catalogue (no approval)", async () => {
    const res = await post("/doctor/medicines", {
      token: S.doc.token,
      body: {
        name: `Paracetol${RUN}`,
        genericName: "Paracetamol",
        strength: "500 mg",
        dosageForm: "tablet",
        manufacturer: "IHS Test Labs",
        description: "Test medicine",
        defaultFrequency: "BD",
        defaultTiming: "after_food",
      },
    });
    expectStatus(res, 201, "create medicine");
    assert.equal(res.data.genericName, "Paracetamol");
    assert.equal(res.data.manufacturer, "IHS Test Labs");
    assert.ok(res.data.medicineMasterId, "linked to a catalogue row");
    S.docMed = res.data;
    const master = await MedicineMaster.findByPk(res.data.medicineMasterId);
    assert.equal(master.createdByRole, "doctor");
    assert.equal(String(master.createdBy), String(S.doc.id));
    assert.equal(master.isActive, true, "usable immediately — no admin approval");
  });

  it("refuses a duplicate (same name + strength)", async () => {
    const res = await post("/doctor/medicines", {
      token: S.doc.token,
      body: { name: `paracetol${RUN}`, strength: "500mg", dosageForm: "tablet" },
    });
    expectStatus(res, 409, "duplicate");
    assert.equal(res.body.error.code, "MEDICINE_DUPLICATE");
  });

  it("the prescription search shows the own medicine with its catalogue link", async () => {
    const res = await get(`/doctor/emr/search/medicines?q=${encodeURIComponent(`Paracetol${RUN}`)}`, { token: S.doc.token });
    expectStatus(res, 200, "search");
    const mine = res.data.find((h) => h.source === "mine");
    assert.ok(mine);
    assert.equal(mine.catalogueId, S.docMed.medicineMasterId);
    assert.equal(mine.genericName, "Paracetamol");
    assert.equal(mine.strength, "500 mg");
  });

  it("patients can find the doctor-added medicine in the catalogue", async () => {
    const res = await get(`/patient/medicines/search?q=${encodeURIComponent(`Paracetol${RUN}`)}`, { token: S.patA.token });
    expectStatus(res, 200, "patient search");
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].id, S.docMed.medicineMasterId);
    assert.equal(res.data[0].dosageForm, "tablet");
  });
});

// ── Prescription → patient sync ─────────────────────────────────────────────
describe("Prescription to patient sync", () => {
  it("a draft prescription adds nothing to the patient's medicines", async () => {
    const draft = await post("/doctor/prescriptions", { token: S.doc.token, body: { bookingId: S.bookingId } });
    expectStatus(draft, 201, "draft");
    S.rxId = String(draft.data.id);
    const upd = await patch(`/doctor/prescriptions/${S.rxId}`, {
      token: S.doc.token,
      body: {
        items: [
          {
            medicineId: S.docMed.id,
            medicineMasterId: S.docMed.medicineMasterId,
            medicineName: `Paracetol${RUN} 500 mg`,
            strength: "500 mg",
            dosageForm: "tablet",
            dosage: "1 tablet",
            frequency: "BD",
            timing: "after_food",
            durationDays: 5,
          },
          { medicineName: `Coughsyr${RUN}`, dosageForm: "syrup", dosage: "10 ml", frequency: "TDS", timing: "before_food", durationDays: 1, durationUnit: "week" },
        ],
      },
    });
    expectStatus(upd, 200, "items");
    const list = await get("/patient/medicines", { token: S.patA.token });
    expectStatus(list, 200, "list");
    assert.equal(list.data.length, 0);
  });

  it("finalize copies every line once, keeping strength apart from the dose", async () => {
    const fin = await post(`/doctor/prescriptions/${S.rxId}/finalize`, { token: S.doc.token, body: {} });
    expectStatus(fin, 200, "finalize");
    const list = await get("/patient/medicines?source=prescription", { token: S.patA.token });
    assert.equal(list.data.length, 2);
    const para = list.data.find((m) => m.medicineName === `Paracetol${RUN}`);
    assert.ok(para, "label without the strength suffix");
    assert.equal(para.strength, "500 mg");
    assert.equal(para.dose, "1 tablet");
    assert.equal(para.frequency, "BD");
    assert.equal(para.foodTiming, "after_food");
    assert.equal(para.durationDays, 5);
    assert.equal(para.endDate, sched.addDays(para.startDate, 4));
    assert.equal(para.verified, true);
    assert.equal(para.needsSetup, true);
    assert.equal(para.suggestedReminderCount, 2);
    assert.equal(para.genericName, "Paracetamol");
    assert.equal(para.prescriber.id, String(S.doc.id));
    assert.equal(para.prescribed.dosage, "1 tablet");
    const syr = list.data.find((m) => m.medicineName === `Coughsyr${RUN}`);
    assert.equal(syr.durationDays, 7, "1 week = 7 days");
    S.rxPara = para;
    S.rxSyr = syr;

    const note = await MedicineNotification.findOne({ where: { userId: S.patA.id, type: "medicine_prescribed", referenceId: S.rxId } });
    assert.ok(note, "patient notified");
  });

  it("finalizing again or re-running the sync never duplicates", async () => {
    const again = await post(`/doctor/prescriptions/${S.rxId}/finalize`, { token: S.doc.token, body: {} });
    expectStatus(again, 200, "re-finalize");
    const res = await patientMedicine.syncFromPrescription(S.rxId);
    assert.equal(res.created, 0);
    assert.equal(await PatientMedicine.count({ where: { patientId: S.patA.id, prescriptionId: S.rxId } }), 2);
  });

  it("the patient may set reminder times but not change the doctor's instructions", async () => {
    const locked = await patch(`/patient/medicines/${S.rxPara.id}`, { token: S.patA.token, body: { dose: "2 tablets" } });
    expectStatus(locked, 409, "locked");
    assert.equal(locked.body.error.code, "PRESCRIBED_FIELD_LOCKED");
    const ok = await patch(`/patient/medicines/${S.rxPara.id}`, { token: S.patA.token, body: { reminderTimes: ["20:00", "08:00"] } });
    expectStatus(ok, 200, "times");
    assert.deepEqual(ok.data.reminderTimes, ["08:00", "20:00"]);
    assert.equal(ok.data.reminderEnabled, true, "first times switch reminders on");
    assert.equal(ok.data.needsSetup, false);
    assert.equal(ok.data.dose, "1 tablet");
    assert.ok((await MedicineDoseLog.count({ where: { patientMedicineId: S.rxPara.id } })) > 0, "doses generated");
  });
});

// ── Patient's own medicines ─────────────────────────────────────────────────
describe("Patient own medicines", () => {
  it("adds several medicines in one request, each with its own schedule", async () => {
    S.reqA = `a${RUN}`;
    S.reqB = `b${RUN}`;
    S.t1 = clockIn(3);
    S.t2 = clockIn(5);
    const res = await post("/patient/medicines", {
      token: S.patA.token,
      body: {
        timezone: TZ,
        items: [
          {
            clientRequestId: S.reqA,
            medicineMasterId: S.docMed.medicineMasterId,
            dose: "1 tablet",
            frequency: "BD",
            foodTiming: "after_food",
            reminderTimes: [S.t1, S.t2],
            startDate: todayLocal(),
            durationDays: 3,
          },
          {
            clientRequestId: S.reqB,
            medicineName: `Herbal${RUN}`,
            strength: "5 ml",
            dosageForm: "syrup",
            dose: "5 ml",
            frequency: "OD",
            foodTiming: "before_food",
            reminderTimes: ["06:00"],
            startDate: todayLocal(),
          },
        ],
      },
    });
    expectStatus(res, 201, "create own");
    assert.equal(res.data.length, 2);
    const [a, b] = res.data;
    assert.equal(a.source, "patient");
    assert.equal(a.verified, false);
    assert.equal(a.medicineName, `Paracetol${RUN}`, "identity from the catalogue");
    assert.equal(a.strength, "500 mg");
    assert.equal(a.endDate, sched.addDays(todayLocal(), 2));
    assert.equal(b.frequency, "OD");
    assert.equal(b.foodTiming, "before_food");
    assert.equal(b.endDate, null, "ongoing");
    assert.deepEqual(b.reminderTimes, ["06:00"]);
    S.ownA = a;
    S.ownB = b;
  });

  it("a retried request returns the same rows instead of duplicates", async () => {
    const res = await post("/patient/medicines", {
      token: S.patA.token,
      body: { items: [{ clientRequestId: S.reqA, medicineMasterId: S.docMed.medicineMasterId, reminderTimes: [S.t1], startDate: todayLocal() }] },
    });
    expectStatus(res, 201, "retry");
    assert.equal(res.data[0].id, S.ownA.id);
    assert.equal(await PatientMedicine.count({ where: { patientId: S.patA.id, source: "patient" } }), 2);
  });

  it("a patient-typed medicine stays private (not added to the shared catalogue)", async () => {
    const res = await get(`/patient/medicines/search?q=Herbal${RUN}`, { token: S.patA.token });
    assert.equal(res.data.length, 0);
  });

  it("rejects an invalid schedule", async () => {
    const res = await post("/patient/medicines", {
      token: S.patA.token,
      body: { items: [{ medicineName: "X", reminderTimes: ["25:00"], startDate: "31-10-2026" }] },
    });
    expectStatus(res, 422, "validation");
  });
});

// ── Doses ───────────────────────────────────────────────────────────────────
describe("Dose actions", () => {
  it("today's doses include the new routine's upcoming slots", async () => {
    S.sock = await connectSocket(S.patA.token);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 26 * 3600_000).toISOString();
    const res = await get(`/patient/medicines/doses?from=${from}&to=${to}`, { token: S.patA.token });
    expectStatus(res, 200, "doses");
    const mine = res.data.filter((d) => d.patientMedicineId === S.ownA.id);
    assert.ok(mine.length >= 2);
    S.d1 = mine.find((d) => d.scheduledTime === S.t1);
    S.d2 = mine.find((d) => d.scheduledTime === S.t2);
    assert.ok(S.d1 && S.d2, "both slots generated");
    assert.equal(S.d1.status, "pending");
    assert.equal(S.d1.medicine.strength, "500 mg");
    S.dFar = mine.find((d) => new Date(d.scheduledAt).getTime() - Date.now() > 13 * 3600_000);
  });

  it("taken is idempotent and audited once; it also reaches the patient's other apps live", async () => {
    const first = await post(`/patient/medicines/doses/${S.d1.id}/action`, { token: S.patA.token, body: { action: "taken", source: "mobile" } });
    expectStatus(first, 200, "taken");
    assert.equal(first.data.changed, true);
    assert.equal(first.data.dose.status, "taken");
    assert.ok(first.data.dose.actionAt);
    const again = await post(`/patient/medicines/doses/${S.d1.id}/action`, { token: S.patA.token, body: { action: "taken" } });
    expectStatus(again, 200, "taken again");
    assert.equal(again.data.changed, false);
    assert.equal(await MedicineDoseEvent.count({ where: { doseLogId: S.d1.id, action: "taken" } }), 1);
    const skip = await post(`/patient/medicines/doses/${S.d1.id}/action`, { token: S.patA.token, body: { action: "skipped" } });
    expectStatus(skip, 409, "skip a taken dose");
    assert.equal(skip.body.error.code, "DOSE_ALREADY_TAKEN");
    assert.ok(
      await waitFor(() => S.sock.events.some((e) => e.event === "medicine_dose_updated" && e.payload.id === S.d1.id)),
      "socket push received"
    );
  });

  it("snooze keeps the original slot and moves only the due time", async () => {
    const res = await post(`/patient/medicines/doses/${S.d2.id}/action`, {
      token: S.patA.token,
      body: { action: "snooze", snoozeMinutes: 10 },
    });
    expectStatus(res, 200, "snooze");
    assert.equal(res.data.dose.status, "snoozed");
    assert.equal(res.data.dose.scheduledAt, S.d2.scheduledAt);
    const due = new Date(res.data.dose.dueAt).getTime();
    assert.ok(Math.abs(due - (Date.now() + 10 * 60_000)) < 60_000);
    assert.equal(res.data.dose.snoozeCount, 1);
    // A range that starts after the original slot still returns the snoozed dose (by its due time).
    const from = new Date(new Date(S.d2.scheduledAt).getTime() + 60_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const ranged = await get(`/patient/medicines/doses?from=${from}&to=${to}`, { token: S.patA.token });
    assert.ok(ranged.data.some((d) => d.id === S.d2.id), "snoozed dose found by dueAt");
    const bad = await post(`/patient/medicines/doses/${S.d2.id}/action`, { token: S.patA.token, body: { action: "snooze", snoozeMinutes: 7 } });
    expectStatus(bad, 422, "unsupported snooze length");
  });

  it("skip, then taken later, are both allowed and logged", async () => {
    const skip = await post(`/patient/medicines/doses/${S.d2.id}/action`, { token: S.patA.token, body: { action: "skipped" } });
    expectStatus(skip, 200, "skip");
    assert.equal(skip.data.dose.status, "skipped");
    const snoozeSkipped = await post(`/patient/medicines/doses/${S.d2.id}/action`, { token: S.patA.token, body: { action: "snooze", snoozeMinutes: 5 } });
    expectStatus(snoozeSkipped, 409, "snooze a skipped dose");
    const taken = await post(`/patient/medicines/doses/${S.d2.id}/action`, { token: S.patA.token, body: { action: "taken" } });
    expectStatus(taken, 200, "taken after skip");
    const events = await MedicineDoseEvent.findAll({ where: { doseLogId: S.d2.id }, order: [["id", "ASC"]] });
    assert.deepEqual(events.map((e) => e.action), ["snoozed", "skipped", "taken"]);
  });

  it("a dose far in the future can't be acted on", async () => {
    if (!S.dFar) return; // only when tomorrow's slot is > 12 h away
    const res = await post(`/patient/medicines/doses/${S.dFar.id}/action`, { token: S.patA.token, body: { action: "taken" } });
    expectStatus(res, 409, "future dose");
    assert.equal(res.body.error.code, "DOSE_NOT_ACTIONABLE");
  });

  it("an open dose past the grace period is recorded as missed (never as taken)", async () => {
    const dose = await MedicineDoseLog.findOne({
      where: { patientMedicineId: S.ownB.id, status: "pending" },
      order: [["scheduledAt", "ASC"]],
    });
    const past = new Date(Date.now() - 3 * 3600_000);
    await dose.update({ scheduledAt: past, dueAt: past });
    const res = await get("/patient/medicines/doses/history?limit=50", { token: S.patA.token });
    expectStatus(res, 200, "history");
    const row = res.data.doses.find((d) => d.id === String(dose.id));
    assert.equal(row.status, "missed");
    assert.equal(await MedicineDoseEvent.count({ where: { doseLogId: dose.id, action: "missed" } }), 1);
    S.missedDose = String(dose.id);
  });

  it("due reminders are sent once, and privacy mode hides the medicine name", async () => {
    const dose = await MedicineDoseLog.findOne({ where: { patientMedicineId: S.rxPara.id, status: "pending" }, order: [["scheduledAt", "ASC"]] });
    const now = new Date(Date.now() - 60_000);
    await dose.update({ dueAt: now, notifiedAt: null });
    await reminderSweep.sendDueReminders();
    await reminderSweep.sendDueReminders();
    const notes = await MedicineNotification.findAll({ where: { userId: S.patA.id, type: "medicine_dose_due", referenceId: dose.id } });
    assert.equal(notes.length, 1, "exactly one reminder");
    assert.match(notes[0].message, new RegExp(`Paracetol${RUN}`));
    assert.equal((await dose.reload()).status, "pending", "delivering a reminder never marks it taken");

    const set = await put("/patient/medicines/settings", { token: S.patA.token, body: { privacyMode: true } });
    expectStatus(set, 200, "privacy on");
    const dose2 = await MedicineDoseLog.findOne({
      where: { patientMedicineId: S.rxPara.id, status: "pending", id: { [require("sequelize").Op.ne]: dose.id } },
      order: [["scheduledAt", "ASC"]],
    });
    await dose2.update({ dueAt: now, notifiedAt: null });
    await reminderSweep.sendDueReminders();
    const private_ = await MedicineNotification.findOne({ where: { userId: S.patA.id, type: "medicine_dose_due", referenceId: dose2.id } });
    assert.ok(private_);
    assert.doesNotMatch(private_.message, new RegExp(`Paracetol${RUN}`));
    await put("/patient/medicines/settings", { token: S.patA.token, body: { privacyMode: false } });
  });

  it("the summary counts real dose rows", async () => {
    const res = await get("/patient/medicines/summary", { token: S.patA.token });
    expectStatus(res, 200, "summary");
    assert.ok(res.data.routines.active >= 4);
    assert.equal(res.data.routines.needsSetup, 1, "the syrup still has no times");
    assert.ok(res.data.adherence.week.taken >= 2);
    assert.ok(res.data.adherence.week.missed >= 1);
    assert.equal(res.data.adherence.days.length, 7);
    assert.equal(res.data.timezone, TZ);
  });
});

// ── Routine lifecycle ───────────────────────────────────────────────────────
describe("Pause, resume, stop, complete", () => {
  it("pause clears future reminders; resume brings them back", async () => {
    const paused = await put(`/patient/medicines/${S.ownB.id}/status`, { token: S.patA.token, body: { status: "paused" } });
    expectStatus(paused, 200, "pause");
    assert.equal(paused.data.status, "paused");
    const { Op } = require("sequelize");
    const future = () =>
      MedicineDoseLog.count({ where: { patientMedicineId: S.ownB.id, status: "pending", scheduledAt: { [Op.gt]: new Date() } } });
    assert.equal(await future(), 0);
    assert.equal(await MedicineDoseLog.count({ where: { id: S.missedDose } }), 1, "history kept");
    const resumed = await put(`/patient/medicines/${S.ownB.id}/status`, { token: S.patA.token, body: { status: "active" } });
    expectStatus(resumed, 200, "resume");
    assert.ok((await future()) > 0);
  });

  it("stop ends the routine for good", async () => {
    const stopped = await put(`/patient/medicines/${S.ownB.id}/status`, { token: S.patA.token, body: { status: "cancelled" } });
    expectStatus(stopped, 200, "stop");
    const edit = await patch(`/patient/medicines/${S.ownB.id}`, { token: S.patA.token, body: { reminderTimes: ["07:00"] } });
    expectStatus(edit, 409, "edit stopped");
    assert.equal(edit.body.error.code, "PATIENT_MEDICINE_NOT_EDITABLE");
    const resume = await put(`/patient/medicines/${S.ownB.id}/status`, { token: S.patA.token, body: { status: "active" } });
    expectStatus(resume, 409, "resume stopped");
  });

  it("a routine past its end date is completed by the sweep", async () => {
    await PatientMedicine.update(
      { endDate: sched.addDays(todayLocal(), -2), startDate: sched.addDays(todayLocal(), -5) },
      { where: { id: S.ownA.id } }
    );
    await reminderSweep.completeEnded();
    const res = await get(`/patient/medicines/${S.ownA.id}`, { token: S.patA.token });
    assert.equal(res.data.status, "completed");
    assert.equal(res.data.statusReason, "ended");
    assert.ok(Array.isArray(res.data.recentDoses));
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.patA.id, type: "medicine_routine_completed", referenceId: S.ownA.id } }));
  });
});

// ── Amendment ───────────────────────────────────────────────────────────────
describe("Prescription amendment", () => {
  it("only the finalized new version replaces the old routines; unchanged ones keep their reminders", async () => {
    const amend = await post(`/doctor/prescriptions/${S.rxId}/amend`, { token: S.doc.token, body: { reason: "Change syrup frequency" } });
    expectStatus(amend, 201, "amend");
    S.rx2 = String(amend.data.id);
    const items = amend.data.items.map((i) => ({
      medicineId: i.medicineId,
      medicineMasterId: i.medicineMasterId,
      medicineName: i.medicineName,
      strength: i.strength,
      dosageForm: i.dosageForm,
      dosage: i.dosage,
      frequency: i.medicineName.startsWith("Coughsyr") ? "BD" : i.frequency,
      timing: i.timing,
      durationDays: i.durationDays,
      durationUnit: i.durationUnit,
    }));
    expectStatus(await patch(`/doctor/prescriptions/${S.rx2}`, { token: S.doc.token, body: { items } }), 200, "edit amendment");

    const during = await get("/patient/medicines?source=prescription&status=active", { token: S.patA.token });
    assert.deepEqual(during.data.map((m) => m.prescriptionId).sort(), [S.rxId, S.rxId], "draft changes nothing");

    expectStatus(await post(`/doctor/prescriptions/${S.rx2}/finalize`, { token: S.doc.token, body: {} }), 200, "finalize amendment");
    const list = await get("/patient/medicines?source=prescription", { token: S.patA.token });
    const old = list.data.filter((m) => m.prescriptionId === S.rxId);
    const fresh = list.data.filter((m) => m.prescriptionId === S.rx2);
    assert.equal(old.length, 2);
    assert.ok(old.every((m) => m.status === "cancelled" && m.statusReason === "prescription_amended"));
    assert.equal(fresh.length, 2);
    const para = fresh.find((m) => m.medicineName === `Paracetol${RUN}`);
    assert.deepEqual(para.reminderTimes, ["08:00", "20:00"], "same medicine + frequency keeps the patient's times");
    assert.equal(para.startDate, S.rxPara.startDate, "course start kept");
    const syr = fresh.find((m) => m.medicineName === `Coughsyr${RUN}`);
    assert.equal(syr.frequency, "BD");
    assert.equal(syr.needsSetup, true, "changed frequency → patient re-picks times");
    const oldPara = old.find((m) => m.medicineName === `Paracetol${RUN}`);
    assert.equal(oldPara.supersededById, para.id);
    const { Op } = require("sequelize");
    assert.equal(
      await MedicineDoseLog.count({ where: { patientMedicineId: S.rxPara.id, status: "pending", scheduledAt: { [Op.gt]: new Date() } } }),
      0,
      "old routine's future reminders removed"
    );
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.patA.id, type: "medicine_prescription_updated", referenceId: S.rx2 } }));
    assert.equal(await PatientMedicine.count({ where: { patientId: S.patA.id, source: "patient" } }), 2, "own medicines untouched");
  });
});

// ── Security ────────────────────────────────────────────────────────────────
describe("Access control", () => {
  it("another patient can't see or act on these medicines or doses", async () => {
    const list = await get("/patient/medicines", { token: S.patB.token });
    expectStatus(list, 200, "B list");
    assert.equal(list.data.length, 0);
    expectStatus(await get(`/patient/medicines/${S.rxPara.id}`, { token: S.patB.token }), 404, "B read");
    expectStatus(await patch(`/patient/medicines/${S.rxPara.id}`, { token: S.patB.token, body: { reminderTimes: ["09:00"] } }), 404, "B edit");
    expectStatus(await put(`/patient/medicines/${S.rxPara.id}/status`, { token: S.patB.token, body: { status: "paused" } }), 404, "B pause");
    expectStatus(await post(`/patient/medicines/doses/${S.d1.id}/action`, { token: S.patB.token, body: { action: "skipped" } }), 404, "B dose");
    const hist = await get("/patient/medicines/doses/history", { token: S.patB.token });
    assert.equal(hist.data.total, 0);
  });

  it("a body patient id is ignored — rows always belong to the signed-in patient", async () => {
    const res = await post("/patient/medicines", {
      token: S.patB.token,
      body: { patientId: S.patA.id, items: [{ medicineName: `Bonly${RUN}`, startDate: todayLocal() }] },
    });
    expectStatus(res, 201, "B create");
    const row = await PatientMedicine.findByPk(res.data[0].id);
    assert.equal(String(row.patientId), String(S.patB.id));
  });

  it("doctors and anonymous callers can't use the patient medicine API", async () => {
    expectStatus(await get("/patient/medicines", { token: S.doc.token }), 403, "doctor");
    expectStatus(await get("/patient/medicines"), 401, "anonymous");
    expectStatus(await post("/doctor/medicines", { token: S.patA.token, body: { name: "X", dosageForm: "tablet" } }), 403, "patient → doctor list");
  });
});
