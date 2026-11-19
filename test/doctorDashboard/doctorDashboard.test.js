/**
 * Doctor Dashboard 2.0 + patient acquisition (migration 056) — end-to-end API tests.
 *
 * Part 1 books REAL appointments through POST /patient/bookings (clinic + video)
 * with "How did you hear about Dr. X?" answers and checks storage + attribution.
 * Part 2 builds a controlled practice for a third doctor (bookings, payments,
 * refunds, prescriptions, follow-ups, sessions, acquisition rows) and asserts
 * every KPI against hand-computed values. Part 3 checks isolation.
 *
 *   PORT=5055 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 node src/server.js
 *   DASHBOARD_E2E_BASE_URL=http://localhost:5055 node --test test/doctorDashboard/doctorDashboard.test.js
 *
 * Accounts are inserted directly (local signup may 500 — see test/patientMedicine)
 * and sign in through the real /auth/login. Tagged @ihs-test.example.com and
 * deactivated at the end.
 */
const path = require("path");

const EXTERNAL = process.env.DASHBOARD_E2E_BASE_URL || "";
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
  Payment,
  Prescription,
  Clinic,
  ClinicAvailability,
  ConsultationSession,
  DoctorOnlineAvailability,
  PatientAcquisitionSource,
  BookingAcquisitionSource,
} = require("../../src/models");
const passwordUtil = require("../../src/utils/password");
const { istToday, addDays } = require("../../src/utils/period");

const RUN = Date.now().toString(36);
const PASSWORD = "DashKpi#2026x";
let base;
let server;
const S = { patients: {} };
const TODAY = istToday();
const D = (n) => addDays(TODAY, n);

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
const expectStatus = (res, status, label) =>
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 500)}`);

const email = (who) => `dashkpi-${who}-${RUN}@ihs-test.example.com`;
async function makeUser(who, role) {
  const [cols] = await sequelize.query("SHOW COLUMNS FROM users");
  const names = new Set(cols.map((c) => c.Field));
  const row = { role, name: `${who} Kpi${RUN}`, email: email(who), password_hash: await passwordUtil.hash(PASSWORD), is_active: 1, is_email_verified: 1 };
  if (names.has("userName")) row.userName = `${who}${RUN}`.slice(0, 50);
  if (names.has("phoneNumber")) row.phoneNumber = "9000000002";
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

/** A bookable, verified doctor with a clinic open every day + video every day. */
async function makeDoctor(key) {
  const id = await makeUser(key, "doctor");
  await sequelize.query(
    `INSERT INTO doctor_profiles (user_id, registration_number, verification_status, is_listed, online_fee)
     VALUES (?, ?, 'approved', 1, 500)`,
    { replacements: [id, `REG-${key}-${RUN}`] }
  );
  const clinic = await Clinic.create({ doctorId: id, name: `${key} Clinic ${RUN}`, addressLine: "1 Test Road", city: "Bhubaneswar", offlineFee: 300, isActive: true });
  const days = [0, 1, 2, 3, 4, 5, 6];
  await ClinicAvailability.bulkCreate(days.map((d) => ({ clinicId: clinic.id, dayOfWeek: d, startTime: "00:00:00", endTime: "23:59:00", slotDurationMinutes: 15 })));
  await DoctorOnlineAvailability.bulkCreate(days.map((d) => ({ doctorId: id, dayOfWeek: d, startTime: "00:00:00", endTime: "23:59:00", slotDurationMinutes: 15 })));
  return { id, clinicId: Number(clinic.id), token: await login(key, "doctor") };
}

async function makePatient(key) {
  const id = await makeUser(key, "patient");
  await sequelize.query("INSERT INTO patient_profiles (user_id) VALUES (?)", { replacements: [id] });
  const token = await login(key, "patient");
  const prof = await put("/patient/profile", { token, body: { phone: "9876543210", dateOfBirth: "1990-05-17", gender: "female", city: "Bhubaneswar" } });
  expectStatus(prof, 200, `profile ${key}`);
  return { id, token };
}

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  S.docA = await makeDoctor("docA");
  S.docB = await makeDoctor("docB");
  for (let i = 1; i <= 10; i += 1) S.patients[`p${i}`] = await makePatient(`p${i}`);
});

after(async () => {
  const ids = [S.docA?.id, S.docB?.id, S.docC?.id, ...Object.values(S.patients).map((p) => p.id), ...(S.cPatients ?? [])].filter(Boolean);
  if (ids.length) {
    await User.update({ isActive: false }, { where: { id: ids } });
    await Booking.update({ status: "cancelled", cancelledReason: "e2e_cleanup" }, { where: { doctorId: ids, status: ["confirmed", "pending_payment"] } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

const book = (who, body) => post("/patient/bookings", { token: S.patients[who].token, body });
const clinicBooking = (doc, date, extra = {}) => ({ doctorId: doc.id, mode: "clinic", clinicId: doc.clinicId, date, paymentMode: "offline", ...extra });
const videoBooking = (doc, date, extra = {}) => ({ doctorId: doc.id, mode: "video", date, paymentMode: "online", ...extra });
const bookingIdOf = (res) => String(res.data?.booking?.id ?? res.data?.id);

// ── Part 1: capture ─────────────────────────────────────────────────────────
describe("Acquisition capture on real bookings", () => {
  it("serves the configurable catalogue", async () => {
    const res = await get("/patient/acquisition/sources", { token: S.patients.p1.token });
    expectStatus(res, 200, "catalogue");
    const groups = res.data.groups.map((g) => g.value);
    assert.deepEqual(groups, ["google", "social", "referral", "ihs", "other", "undisclosed"]);
    const all = res.data.groups.flatMap((g) => g.sources.map((s) => s.value));
    for (const v of ["google_search", "google_maps", "instagram", "facebook", "friend", "doctor_referral", "ihs_website", "ihs_app", "other", "not_sure"]) {
      assert.ok(all.includes(v), `catalogue has ${v}`);
    }
    assert.equal(res.data.groups.find((g) => g.value === "other").sources[0].textField, true);
  });

  it("a video booking stores Google Search as the original source (with UTM kept apart)", async () => {
    const res = await book("p1", videoBooking(S.docA, TODAY, { acquisition: { source: "google_search", capturedVia: "web", utm: { source: "google", campaign: "kpi" } } }));
    expectStatus(res, 201, "video booking");
    S.p1Video = bookingIdOf(res);
    const orig = await PatientAcquisitionSource.findOne({ where: { patientId: S.patients.p1.id, doctorId: S.docA.id } });
    assert.equal(orig.sourceGroup, "google");
    assert.equal(orig.source, "google_search");
    assert.equal(orig.capturedVia, "web");
    assert.deepEqual(orig.utm, { source: "google", campaign: "kpi" });
    assert.equal(String(orig.firstBookingId), S.p1Video);
    const status = await get(`/patient/acquisition/doctors/${S.docA.id}`, { token: S.patients.p1.token });
    assert.deepEqual(status.data, { answered: true, group: "google", source: "google_search" });
  });

  it("a repeat clinic booking keeps the original source and records its own answer", async () => {
    const res = await book("p1", clinicBooking(S.docA, D(1), { acquisition: { source: "instagram", capturedVia: "mobile" } }));
    expectStatus(res, 201, "repeat booking");
    const id = bookingIdOf(res);
    const orig = await PatientAcquisitionSource.findAll({ where: { patientId: S.patients.p1.id, doctorId: S.docA.id } });
    assert.equal(orig.length, 1, "no duplicate original");
    assert.equal(orig[0].source, "google_search", "original never overwritten");
    const own = await BookingAcquisitionSource.findByPk(id);
    assert.equal(own.source, "instagram");
    assert.equal(own.sourceGroup, "social");
    assert.equal(own.capturedVia, "mobile");
  });

  it("referral details are kept only for referral answers; other text only where offered", async () => {
    const res = await book("p2", clinicBooking(S.docA, TODAY, { acquisition: { source: "friend", referralDetails: "Ravi", otherText: "ignored" } }));
    expectStatus(res, 201, "friend");
    const row = await PatientAcquisitionSource.findOne({ where: { patientId: S.patients.p2.id, doctorId: S.docA.id } });
    assert.equal(row.sourceGroup, "referral");
    assert.equal(row.referralDetails, "Ravi");
    assert.equal(row.otherText, null);
    const other = await book("p3", videoBooking(S.docA, TODAY, { acquisition: { source: "other", otherText: "Newspaper" } }));
    expectStatus(other, 201, "other");
    const o = await PatientAcquisitionSource.findOne({ where: { patientId: S.patients.p3.id, doctorId: S.docA.id } });
    assert.equal(o.otherText, "Newspaper");
  });

  it("every listed source lands in the right group for the right doctor", async () => {
    const cases = [
      ["p4", "not_sure", "undisclosed", S.docA],
      ["p6", "ihs_app", "ihs", S.docB],
      ["p7", "google_maps", "google", S.docA],
      ["p8", "facebook", "social", S.docA],
      ["p9", "doctor_referral", "referral", S.docA],
      ["p10", "ihs_website", "ihs", S.docA],
    ];
    for (const [who, source, group, doc] of cases) {
      const res = await book(who, clinicBooking(doc, D(2), { acquisition: { source } }));
      expectStatus(res, 201, `${who} ${source}`);
      const row = await PatientAcquisitionSource.findOne({ where: { patientId: S.patients[who].id, doctorId: doc.id } });
      assert.equal(row.sourceGroup, group, `${source} → ${group}`);
    }
    const p6OnA = await get(`/patient/acquisition/doctors/${S.docA.id}`, { token: S.patients.p6.token });
    assert.equal(p6OnA.data.answered, false, "attribution is per doctor");
  });

  it("skipping the question books normally and records nothing", async () => {
    const res = await book("p5", clinicBooking(S.docA, TODAY));
    expectStatus(res, 201, "no answer");
    assert.equal(await PatientAcquisitionSource.count({ where: { patientId: S.patients.p5.id } }), 0);
    assert.equal(await BookingAcquisitionSource.count({ where: { bookingId: bookingIdOf(res) } }), 0);
  });

  it("rejects unknown sources and oversized text", async () => {
    expectStatus(await book("p5", clinicBooking(S.docA, D(3), { acquisition: { source: "tiktok_magic" } })), 422, "unknown");
    expectStatus(await book("p5", clinicBooking(S.docA, D(3), { acquisition: { source: "other", otherText: "x".repeat(200) } })), 422, "long");
  });

  it("the doctor's acquisition analytics count unique new patients per group", async () => {
    const res = await get(`/doctor/analytics/acquisition?from=${TODAY}&to=${D(3)}`, { token: S.docA.token });
    expectStatus(res, 200, "acquisition");
    const g = Object.fromEntries(res.data.summary.groups.map((x) => [x.group, x.count]));
    // p1 (google_search; repeat booking not double-counted), p7 google_maps → 2
    assert.equal(g.google, 2);
    assert.equal(g.social, 1, "p8 facebook (p1's instagram repeat is not a new patient)");
    assert.equal(g.referral, 2, "p2 friend + p9 doctor");
    assert.equal(g.ihs, 1, "p10 website (p6 belongs to doctor B)");
    assert.equal(g.other, 1);
    assert.equal(g.undisclosed, 1);
    assert.equal(g.not_captured, 1, "p5 skipped");
    assert.equal(res.data.summary.newPatients, 9);
    const google = res.data.summary.groups.find((x) => x.group === "google");
    assert.deepEqual(google.sources.map((s) => s.source).sort(), ["google_maps", "google_search"]);
    const b = await get(`/doctor/analytics/acquisition?from=${TODAY}&to=${D(3)}`, { token: S.docB.token });
    assert.equal(b.data.summary.groups.find((x) => x.group === "ihs").count, 1);
    assert.equal(b.data.summary.newPatients, 1);
  });
});

// ── Part 2: KPI math on a controlled practice ───────────────────────────────
describe("KPI calculations", () => {
  before(async () => {
    S.docC = { id: await makeUser("docC", "doctor") };
    await sequelize.query("INSERT INTO doctor_profiles (user_id, registration_number, verification_status) VALUES (?, ?, 'approved')", {
      replacements: [S.docC.id, `REG-docC-${RUN}`],
    });
    S.docC.token = await login("docC", "doctor");
    const q = {};
    for (let i = 1; i <= 8; i += 1) q[`q${i}`] = await makeUser(`q${i}`, "patient");
    S.cPatients = Object.values(q);
    let t = 0;
    const bk = async (patient, date, status, type = "online", extra = {}) => {
      t += 1;
      const time = `${String(8 + (t % 10)).padStart(2, "0")}:${String((t * 7) % 60).padStart(2, "0")}:00`;
      return Booking.create({
        patientId: patient,
        doctorId: S.docC.id,
        bookingType: type,
        slotDate: date,
        slotStartTime: time,
        slotEndTime: time,
        paymentMode: type === "online" ? "online" : "offline",
        amount: type === "online" ? 500 : 300,
        status,
        ...extra,
      });
    };
    const istAt = (day, hhmm) => new Date(new Date(`${day}T${hhmm}:00+05:30`).getTime());
    const pay = (booking, fields) => Payment.create({ bookingId: booking.id, amount: booking.amount, mode: booking.paymentMode, ...fields });

    const q1old = await bk(q.q1, D(-40), "completed", "offline");
    const q1 = await bk(q.q1, D(-2), "completed", "offline");
    await pay(q1, { offlineMethod: "cash", status: "success", amount: 300, commissionAmount: 45, doctorPayoutAmount: 255, paidAt: istAt(D(-2), "11:00") });
    const q2 = await bk(q.q2, D(-3), "completed", "online", {
      consultStartedAt: istAt(D(-3), "10:00"),
      consultEndedAt: istAt(D(-3), "10:12"),
    });
    await pay(q2, { status: "success", amount: 500, commissionAmount: 75, doctorPayoutAmount: 425, paidAt: istAt(D(-3), "09:00") });
    await Prescription.create({ bookingId: q2.id, doctorId: S.docC.id, patientId: q.q2, status: "finalized", finalizedAt: new Date() });
    await bk(q.q3, D(-1), "cancelled", "online");
    await bk(q.q3, D(-1), "cancelled", "online", { cancelledReason: "hold_expired" });
    const q4 = await bk(q.q4, D(2), "confirmed", "offline");
    await pay(q4, { offlineMethod: "cash", status: "pending_at_clinic", amount: 300 });
    await bk(q.q5, D(-4), "no_show", "offline");
    const q6 = await bk(q.q6, D(-5), "completed", "offline");
    await pay(q6, { offlineMethod: "upi_qr", status: "success", amount: 400, commissionAmount: 0, doctorPayoutAmount: 400, paidAt: istAt(D(-5), "12:00") });
    const q7 = await bk(q.q7, D(-6), "completed", "online");
    await pay(q7, { status: "refunded", amount: 500, refundAmount: 500, paidAt: istAt(D(-6), "09:00"), refundedAt: istAt(D(-1), "15:00") });
    const q8 = await bk(q.q8, D(-1), "confirmed", "offline");
    await pay(q8, { offlineMethod: "cash", status: "pending_at_clinic", amount: 250 });

    const [statusId] = await sequelize.query("INSERT INTO follow_up_statuses (doctor_id, label) VALUES (?, 'Follow up')", { replacements: [S.docC.id] });
    await sequelize.query(
      "INSERT INTO patient_follow_ups (booking_id, doctor_id, patient_id, status_id, follow_up_on) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
      { replacements: [q2.id, S.docC.id, q.q2, statusId, D(5), q1old.id, S.docC.id, q.q1, statusId, D(-3)] }
    );
    // Through the model, like the app (raw-SQL Date replacements are written in local time).
    await ConsultationSession.bulkCreate([
      { doctorId: S.docC.id, sessionDate: D(-2), startTime: "10:00:00", endTime: "13:00:00", status: "completed", startedAt: istAt(D(-2), "10:10") },
      { doctorId: S.docC.id, sessionDate: D(-3), startTime: "10:00:00", endTime: "13:00:00", status: "completed", startedAt: istAt(D(-3), "10:30") },
    ]);
    await PatientAcquisitionSource.bulkCreate([
      { patientId: q.q2, doctorId: S.docC.id, sourceGroup: "google", source: "google_maps" },
      { patientId: q.q6, doctorId: S.docC.id, sourceGroup: "social", source: "facebook" },
    ]);
    const res = await get(`/doctor/analytics/overview?from=${D(-10)}&to=${D(10)}`, { token: S.docC.token });
    expectStatus(res, 200, "overview");
    S.ov = res.data;
  });

  it("patients: unique, new vs returning, cancellations exclude abandoned checkouts", () => {
    const p = S.ov.patients;
    assert.equal(p.total, 6, "q1 q2 q4 q6 q7 q8 (cancelled / no-show only are not patients)");
    assert.equal(p.new, 5, "q1's first visit was 40 days ago");
    assert.equal(p.seenInPeriod, 6);
    assert.equal(p.returning, 1);
    assert.equal(p.returningPercent, 16.7);
    assert.equal(p.cancellations.count, 1, "the expired hold is not a cancellation");
    assert.equal(p.cancellations.rate, 12.5);
  });

  it("appointments: status breakdown, completion rate counts appointments that are over", () => {
    const a = S.ov.appointments.period;
    assert.equal(a.total, 8);
    assert.equal(a.completed, 4);
    assert.equal(a.byStatus.confirmed, 2);
    assert.equal(a.noShow, 1);
    assert.equal(a.notMarkedComplete, 1, "q8: confirmed, date passed");
    assert.equal(a.completionRate, 57.1, "4 of 7 concluded");
    assert.equal(S.ov.appointments.consultDuration.averageMinutes, 12);
    assert.equal(S.ov.appointments.consultDuration.measured, 1);
    assert.equal(S.ov.appointments.waitingTime.available, false, "no check-in time → not invented");
  });

  it("money: collected excludes refunds and unpaid cash; methods and outstanding are exact", () => {
    const f = S.ov.financial;
    assert.equal(f.period.collected, 1200, "500 online + 400 UPI + 300 cash; refunded and pending excluded");
    assert.equal(f.period.commission, 120);
    assert.equal(f.period.doctorNet, 1080);
    assert.deepEqual(f.period.methods, { online: 500, cash: 300, upi: 400 });
    assert.deepEqual(f.period.consultation, { clinic: 700, video: 500, total: 1200 });
    assert.equal(f.period.refunded, 500);
    assert.equal(f.period.averagePerCompletedConsult, 400);
    assert.deepEqual(f.pending, { amount: 550, count: 2, overdueAmount: 250, overdueCount: 1 });
    assert.equal(f.procedureRevenue.available, false);
  });

  it("quality: documentation and follow-up compliance from real rows; no invented ratings", () => {
    const q = S.ov.quality;
    assert.equal(q.documentation.completedConsultations, 4);
    assert.equal(q.documentation.withFinalizedPrescription, 1);
    assert.equal(q.documentation.rate, 25);
    assert.deepEqual(q.followUp, { scheduled: 2, completed: 1, pending: 1, overdue: 0, rate: 100 });
    assert.equal(q.satisfaction.available, false);
    assert.equal(q.feedback.available, false);
  });

  it("productivity: per-day averages and session adherence", () => {
    const p = S.ov.productivity;
    assert.equal(p.consultations, 4);
    assert.equal(p.workingDays, 4);
    assert.equal(p.consultationsPerDay, 1);
    assert.equal(p.scheduleAdherence.sessions, 2);
    assert.equal(p.scheduleAdherence.onTime, 1);
    assert.equal(p.scheduleAdherence.rate, 50);
    assert.equal(p.utilization.available, false, "docC has no weekly schedule");
  });

  it("acquisition: new patients by original source, the rest not captured", () => {
    const g = Object.fromEntries(S.ov.acquisition.groups.map((x) => [x.group, x.count]));
    assert.equal(S.ov.acquisition.newPatients, 5);
    assert.equal(g.google, 1);
    assert.equal(g.social, 1);
    assert.equal(g.not_captured, 3);
  });

  it("trends and explore pages return consistent, zero-filled data", async () => {
    const tr = await get(`/doctor/analytics/trends?from=${D(-10)}&to=${D(10)}&granularity=day`, { token: S.docC.token });
    expectStatus(tr, 200, "trends");
    assert.equal(tr.data.revenue.length, 21, "one point per day");
    assert.equal(tr.data.revenue.reduce((a, x) => a + x.collected, 0), 1200);
    assert.equal(tr.data.revenue.reduce((a, x) => a + x.refunded, 0), 500);
    assert.equal(tr.data.appointments.reduce((a, x) => a + x.completed, 0), 4);

    const pts = await get(`/doctor/analytics/patients?from=${D(-10)}&to=${D(10)}&segment=new&limit=50`, { token: S.docC.token });
    expectStatus(pts, 200, "patients");
    assert.equal(pts.data.total, 5);
    const q2 = pts.data.patients.find((x) => x.name.startsWith("q2"));
    assert.equal(q2.acquisitionSource.source, "google_maps");
    assert.match(q2.registrationNumber, /^IHS-P-\d{6,}$/);
    const ret = await get(`/doctor/analytics/patients?from=${D(-10)}&to=${D(10)}&segment=returning`, { token: S.docC.token });
    assert.equal(ret.data.total, 1);
    assert.equal(ret.data.patients[0].visits, 2);

    const ap = await get(`/doctor/analytics/appointments?from=${D(-10)}&to=${D(10)}&status=completed&limit=50`, { token: S.docC.token });
    assert.equal(ap.data.total, 4);
    assert.ok(ap.data.appointments.some((x) => x.consultMinutes === 12));
    const cancelled = await get(`/doctor/analytics/appointments?from=${D(-10)}&to=${D(10)}&status=cancelled`, { token: S.docC.token });
    assert.equal(cancelled.data.total, 1, "abandoned checkout hidden from the list too");

    const fin = await get(`/doctor/analytics/financial?from=${D(-10)}&to=${D(10)}&limit=50`, { token: S.docC.token });
    expectStatus(fin, 200, "financial");
    const refunded = fin.data.transactions.find((x) => x.status === "refunded");
    assert.equal(refunded.collected, 0, "a refunded payment is never shown as collected");
    assert.equal(refunded.refunded, 500);
    const upi = await get(`/doctor/analytics/financial?from=${D(-10)}&to=${D(10)}&method=upi`, { token: S.docC.token });
    assert.equal(upi.data.total, 1);

    for (const page of ["quality", "productivity", "acquisition"]) {
      const res = await get(`/doctor/analytics/${page}?from=${D(-10)}&to=${D(10)}`, { token: S.docC.token });
      expectStatus(res, 200, page);
    }
  });

  it("validates ranges", async () => {
    expectStatus(await get(`/doctor/analytics/overview?from=${D(1)}&to=${D(0)}`, { token: S.docC.token }), 400, "inverted");
    expectStatus(await get(`/doctor/analytics/overview?from=2020-01-01&to=${TODAY}`, { token: S.docC.token }), 400, "too long");
    expectStatus(await get("/doctor/analytics/overview?from=31-10-2026", { token: S.docC.token }), 422, "bad date");
    expectStatus(await get(`/doctor/analytics/trends?from=${D(-200)}&to=${TODAY}&granularity=day`, { token: S.docC.token }), 400, "daily cap");
  });
});

// ── Part 3: isolation ───────────────────────────────────────────────────────
describe("Isolation", () => {
  it("a doctor only ever sees their own practice — a doctorId in the query is ignored", async () => {
    const mine = await get(`/doctor/analytics/overview?from=${D(-10)}&to=${D(10)}`, { token: S.docA.token });
    const spoof = await get(`/doctor/analytics/overview?from=${D(-10)}&to=${D(10)}&doctorId=${S.docC.id}`, { token: S.docA.token });
    expectStatus(spoof, 200, "spoof");
    assert.deepEqual(spoof.data.financial, mine.data.financial);
    assert.notEqual(spoof.data.financial.period.collected, 1200);
    const list = await get(`/doctor/analytics/patients?from=${D(-10)}&to=${D(10)}&limit=100&doctorId=${S.docC.id}`, { token: S.docA.token });
    const cNames = new Set(S.cPatients.map(String));
    assert.ok(list.data.patients.every((x) => !cNames.has(x.id)), "no other doctor's patients");
    const fin = await get(`/doctor/analytics/financial?from=${D(-10)}&to=${D(10)}&limit=100`, { token: S.docA.token });
    assert.ok(fin.data.transactions.every((x) => !cNames.has(x.patient?.id)), "no other doctor's transactions");
  });

  it("patients and anonymous callers can't reach doctor analytics", async () => {
    expectStatus(await get("/doctor/analytics/overview", { token: S.patients.p1.token }), 403, "patient");
    expectStatus(await get("/doctor/analytics/financial"), 401, "anonymous");
    expectStatus(await get("/patient/acquisition/sources", { token: S.docA.token }), 403, "doctor on patient endpoint");
  });
});
