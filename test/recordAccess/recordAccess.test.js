/**
 * Doctor dashboard split, appointment notifications (REST + Socket.IO) and
 * doctor record-access consent (migration 045) — end-to-end API tests.
 *
 * Real HTTP and a real Socket.IO connection, no mocks. Covers:
 *  - dashboard: today's clinic / video split, unique patients this month;
 *  - notifications: persisted for the right recipient only, read/unread,
 *    the doctor role can use the feed, booking events notify;
 *  - sockets: no/forged token refused, a pushed row reaches ONLY its recipient,
 *    the pushed row equals the persisted row;
 *  - consent: unverified doctors refused, search reveals no contact or medical
 *    data, the treating rule is preserved (no duplicate request), one pending
 *    request per category, the patient picks the exact documents, wrong
 *    category / someone else's record refused, only the chosen document is
 *    streamable, another doctor / patient can't read or decide, a doctor can't
 *    approve, reject / revoke / expiry all close access, every step audited.
 *
 * Run against an already-running API (writes tagged test data into THAT
 * server's database; the run's accounts are deactivated at the end):
 *   RECORD_ACCESS_E2E_BASE_URL=http://localhost:5055 node --test test/recordAccess/recordAccess.test.js
 * or in-process against the local `_test` database: npm run test:db && npm test
 */
const path = require("path");

const EXTERNAL = process.env.RECORD_ACCESS_E2E_BASE_URL || "";
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
  DoctorProfile,
  DoctorOnlineAvailability,
  Clinic,
  ClinicAvailability,
  DoctorAccessRequest,
  AccessAuditLog,
  MedicineNotification,
} = require("../../src/models");

const RUN = Date.now().toString(36);
const PASSWORD = "RecAcc#2026x";
let server;
let base;

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
  let json = null;
  try {
    json = buf.length ? JSON.parse(buf.toString("utf8")) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, data: json?.data, raw: buf, headers: res.headers };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

/** Today as YYYY-MM-DD in server-local time (= IST on the dev box). */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const email = (who) => `recacc-${who}-${RUN}@ihs-test.example.com`;
async function register(who, role) {
  const res = await post("/auth/register", {
    body: { name: `${who} Tester${RUN}`, email: email(who), password: PASSWORD, role },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: Number(res.data.user.id), token: res.data.tokens.accessToken, name: res.data.user.name };
}

const fileForm = (text, name, fileType) => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(text)], { type: "application/pdf" }), name);
  form.append("fileType", fileType);
  return form;
};

/** Connect a socket; resolves once the server says it is subscribed. */
function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, { path: "/socket.io", transports: ["websocket"], auth: token ? { token } : {}, reconnection: false });
    const received = [];
    socket.on("notification", (n) => received.push(n));
    socket.once("ready", () => resolve({ socket, received }));
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

const S = {};

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) {
    base = EXTERNAL.replace(/\/+$/, "");
  } else {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    // eslint-disable-next-line global-require
    const realtime = require("../../src/realtime/socket");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    realtime.init(server);
    base = `http://127.0.0.1:${server.address().port}`;
  }

  // docA treats patA. docB is a verified stranger. docC is NOT verified.
  for (const key of ["docA", "docB", "docC"]) {
    S[key] = await register(key, "doctor");
    const [profile] = await DoctorProfile.findOrCreate({
      where: { userId: S[key].id },
      defaults: { userId: S[key].id, registrationNumber: `REG-${key}-${RUN}` },
    });
    await profile.update({
      verificationStatus: key === "docC" ? "pending" : "approved",
      isListed: key === "docA",
      onlineFee: 400,
      registrationNumber: `REG-${key}-${RUN}`,
    });
  }
  await DoctorOnlineAvailability.bulkCreate(
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: S.docA.id, dayOfWeek, startTime: "00:00:00", endTime: "23:59:00", slotDurationMinutes: 15 }))
  );
  const clinic = await Clinic.create({
    doctorId: S.docA.id,
    name: `RA Clinic ${RUN}`,
    addressLine: "1 Test Road",
    city: "Bhubaneswar",
    lat: 20.2961,
    lng: 85.8245,
    offlineFee: 300,
    isActive: true,
  });
  await ClinicAvailability.bulkCreate(
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ clinicId: clinic.id, dayOfWeek, startTime: "00:00:00", endTime: "23:59:00", slotDurationMinutes: 15 }))
  );
  S.clinicId = Number(clinic.id);

  for (const key of ["patA", "patB"]) {
    S[key] = await register(key, "patient");
    const prof = await put("/patient/profile", {
      token: S[key].token,
      body: { phone: "9876543210", dateOfBirth: "1990-05-17", gender: "female", city: "Bhubaneswar" },
    });
    expectStatus(prof, 200, `profile ${key}`);
  }

  // patA's records: two lab reports and one prescription. patB: one lab report.
  S.records = {};
  for (const [key, who, type] of [
    ["lab1", "patA", "lab_report"],
    ["lab2", "patA", "lab_report"],
    ["rx1", "patA", "prescription"],
    ["labB", "patB", "lab_report"],
  ]) {
    const res = await post("/patient/records/upload", { token: S[who].token, form: fileForm(`%PDF-1.4 ${key} ${RUN}`, `${key}.pdf`, type) });
    expectStatus(res, 201, `upload ${key}`);
    S.records[key] = res.data;
  }
  const mine = await get("/patient/records", { token: S.patA.token });
  const all = Array.isArray(mine.data) ? mine.data : (mine.data?.records ?? []);
  for (const key of ["lab1", "lab2", "rx1"]) {
    const url = S.records[key].fileUrl ?? S.records[key].record?.fileUrl;
    const row = all.find((r) => r.fileUrl === url) ?? S.records[key];
    S.records[key] = { id: String(row.id), fileUrl: row.fileUrl };
  }
  const bRecs = await get("/patient/records", { token: S.patB.token });
  const bRow = (Array.isArray(bRecs.data) ? bRecs.data : (bRecs.data?.records ?? []))[0];
  S.records.labB = { id: String(bRow.id), fileUrl: bRow.fileUrl };
});

after(async () => {
  for (const s of Object.values(S)) s?.socket?.socket?.close?.();
  if (EXTERNAL) {
    const ids = ["docA", "docB", "docC", "patA", "patB"].map((k) => S[k]?.id).filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

// ── Dashboard + appointment notifications ────────────────────────────────────
describe("Doctor dashboard and appointment notifications", () => {
  it("books one clinic and one video appointment for today", async () => {
    const clinicBk = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docA.id, mode: "clinic", clinicId: S.clinicId, date: today(), paymentMode: "offline" },
    });
    expectStatus(clinicBk, 201, "clinic booking");
    S.clinicBooking = (clinicBk.data.booking ?? clinicBk.data).id;
    const videoBk = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docA.id, mode: "video", date: today(), paymentMode: "online" },
    });
    expectStatus(videoBk, 201, "video booking");
    S.videoBooking = (videoBk.data.booking ?? videoBk.data).id;
    assert.equal((videoBk.data.booking ?? videoBk.data).status, "confirmed", "dev server auto-confirms when Razorpay is not configured");
  });

  it("splits today's appointments into clinic and video, and counts the patient once", async () => {
    const res = await get("/doctor/dashboard/summary", { token: S.docA.token });
    expectStatus(res, 200, "summary");
    assert.equal(res.data.todaysClinic, 1);
    assert.equal(res.data.todaysVideo, 1);
    assert.equal(res.data.todaysAppointments, 2, "total = clinic + video");
    assert.equal(res.data.patientsThisMonth, 1, "two bookings, one unique patient");
  });

  it("notifies the doctor (and only the doctor) about each booking", async () => {
    const doc = await get("/medicine/notifications", { token: S.docA.token });
    expectStatus(doc, 200, "doctor feed");
    const booked = doc.data.notifications.filter((n) => n.type === "appointment_booked");
    assert.equal(booked.length, 2);
    assert.ok(booked.every((n) => n.referenceType === "booking"));
    assert.ok(booked.some((n) => String(n.referenceId) === String(S.clinicBooking)));
    assert.equal(doc.data.unreadCount, 2);
    const other = await get("/medicine/notifications", { token: S.docB.token });
    assert.equal(other.data.total, 0, "another doctor sees none of them");
  });

  it("a doctor can mark a notification read, but not someone else's", async () => {
    const doc = await get("/medicine/notifications", { token: S.docA.token });
    const n = doc.data.notifications[0];
    expectStatus(await put(`/medicine/notifications/${n.id}/read`, { token: S.docB.token }), 403, "other doctor marks read");
    expectStatus(await put(`/medicine/notifications/${n.id}/read`, { token: S.docA.token }), 200, "own mark read");
    const count = await get("/medicine/notifications/unread-count", { token: S.docA.token });
    assert.equal(count.data.unreadCount, 1, "read state persisted");
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
describe("Real-time notifications (Socket.IO)", () => {
  it("refuses a connection without a token or with a forged one", async () => {
    await assert.rejects(connectSocket(null), (err) => err.data?.code === "UNAUTHENTICATED");
    await assert.rejects(connectSocket("not.a.jwt"), (err) => err.data?.code === "TOKEN_INVALID");
  });

  it("pushes a new row only to its recipient, identical to the stored row", async () => {
    S.docA.socket = (await connectSocket(S.docA.token));
    S.docB.socket = (await connectSocket(S.docB.token));
    S.patB.socket = (await connectSocket(S.patB.token));
    // A client cannot subscribe itself to another user's room.
    S.patB.socket.socket.emit("join", `user:${S.docA.id}`);

    const cancel = await post(`/patient/bookings/${S.clinicBooking}/cancel`, { token: S.patA.token, body: { reason: "test" } });
    expectStatus(cancel, 200, "patient cancels");

    assert.ok(await waitFor(() => S.docA.socket.received.length >= 1), "doctor A received the push");
    const pushed = S.docA.socket.received.find((n) => n.type === "appointment_cancelled");
    assert.ok(pushed, "cancellation pushed");
    const stored = await MedicineNotification.findByPk(pushed.id);
    assert.equal(String(stored.userId), String(S.docA.id));
    assert.equal(stored.title, pushed.title);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(S.docB.socket.received.length, 0, "another doctor received nothing");
    assert.equal(S.patB.socket.received.length, 0, "another patient received nothing, even after asking to join");
  });

  it("a reconnecting client recovers missed rows from the REST feed", async () => {
    S.docA.socket.socket.close();
    // While disconnected: the doctor reschedules nothing; the patient's video booking completes.
    const done = await post(`/doctor/bookings/${S.videoBooking}/complete`, { token: S.docA.token, body: { noShow: false } });
    expectStatus(done, 200, "complete video consult");
    const patFeed = await get("/medicine/notifications?unreadOnly=true", { token: S.patA.token });
    assert.ok(patFeed.data.notifications.some((n) => n.type === "consultation_completed" && String(n.referenceId) === String(S.videoBooking)));
  });
});

// ── Consent ──────────────────────────────────────────────────────────────────
describe("Patient search", () => {
  it("is refused to an unverified doctor and to patients", async () => {
    const res = await get(`/doctor/patient-search?q=${encodeURIComponent("patA Tester")}`, { token: S.docC.token });
    expectStatus(res, 403, "unverified doctor");
    assert.equal(res.body.error.code, "DOCTOR_NOT_VERIFIED");
    expectStatus(await get("/doctor/patient-search?q=abcd", { token: S.patA.token }), 403, "patient");
  });

  it("needs at least 3 characters (never browses everyone)", async () => {
    expectStatus(await get("/doctor/patient-search?q=ab", { token: S.docB.token }), 422, "short");
    expectStatus(await get("/doctor/patient-search", { token: S.docB.token }), 422, "missing");
  });

  it("returns basic, non-medical fields and the treating relationship", async () => {
    const res = await get(`/doctor/patient-search?q=${encodeURIComponent(`patA Tester${RUN}`)}`, { token: S.docB.token });
    expectStatus(res, 200, "search");
    const row = res.data.patients.find((p) => p.id === String(S.patA.id));
    assert.ok(row, "found");
    assert.equal(row.treating, false);
    for (const key of ["email", "phone", "records", "uploadedRecords", "allergies"]) assert.equal(row[key], undefined, `no ${key}`);
    const mine = await get(`/doctor/patient-search?q=${encodeURIComponent(`patA Tester${RUN}`)}`, { token: S.docA.token });
    assert.equal(mine.data.patients.find((p) => p.id === String(S.patA.id)).treating, true);
    const audits = await AccessAuditLog.count({ where: { doctorId: S.docB.id, action: "patient_search" } });
    assert.ok(audits >= 1, "search audited");
  });

  it("the patient card carries no medical data, and 404s for non-patients", async () => {
    const card = await get(`/doctor/patient-search/${S.patA.id}`, { token: S.docB.token });
    expectStatus(card, 200, "card");
    assert.deepEqual(Object.keys(card.data).sort(), ["patient", "requests", "treating"]);
    expectStatus(await get(`/doctor/patient-search/${S.docA.id}`, { token: S.docB.token }), 404, "a doctor is not a patient");
  });
});

describe("Record-access consent", () => {
  it("preserves the treating rule: a treating doctor does not need (or get) a request", async () => {
    const res = await post("/doctor/access-requests", {
      token: S.docA.token,
      body: { patientId: S.patA.id, category: "lab_report", purpose: "Review of earlier reports" },
    });
    expectStatus(res, 409, "treating doctor");
    assert.equal(res.body.error.code, "ACCESS_ALREADY_AUTHORIZED");
  });

  it("validates the request and refuses unverified doctors", async () => {
    expectStatus(await post("/doctor/access-requests", { token: S.docB.token, body: { patientId: S.patA.id, category: "everything", purpose: "Second opinion please" } }), 422, "bad category");
    expectStatus(await post("/doctor/access-requests", { token: S.docB.token, body: { patientId: S.patA.id, category: "lab_report", purpose: "short" } }), 422, "short purpose");
    expectStatus(await post("/doctor/access-requests", { token: S.docC.token, body: { patientId: S.patA.id, category: "lab_report", purpose: "Second opinion please" } }), 403, "unverified");
  });

  it("creates a pending request, notifies the patient, and allows only one per category", async () => {
    const res = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "lab_report", purpose: "Second opinion on blood work", status: "approved" },
    });
    expectStatus(res, 201, "create");
    assert.equal(res.data.status, "pending", "a client-sent status is ignored");
    assert.deepEqual(res.data.records, []);
    S.reqLab = res.data.id;

    const dup = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "lab_report", purpose: "Second opinion on blood work" },
    });
    expectStatus(dup, 409, "duplicate");
    assert.equal(dup.body.error.code, "ACCESS_REQUEST_PENDING");

    const feed = await get("/medicine/notifications", { token: S.patA.token });
    const n = feed.data.notifications.find((x) => x.type === "record_access_requested");
    assert.ok(n, "patient notified");
    assert.equal(n.referenceType, "doctor_access_request");
    assert.equal(String(n.referenceId), S.reqLab);
  });

  it("nobody else can see or decide the request", async () => {
    expectStatus(await get(`/patient/access-requests/${S.reqLab}`, { token: S.patB.token }), 404, "other patient reads");
    expectStatus(await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.patB.token, body: { recordIds: [S.records.labB.id] } }), 404, "other patient approves");
    expectStatus(await get(`/doctor/access-requests/${S.reqLab}`, { token: S.docA.token }), 404, "other doctor reads");
    expectStatus(await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.docB.token, body: { recordIds: [S.records.lab1.id] } }), 403, "the doctor approves own request");
  });

  it("before approval the doctor gets no document", async () => {
    const file = await get(`/doctor/access-requests/${S.reqLab}/records/${S.records.lab1.id}/file`, { token: S.docB.token });
    expectStatus(file, 403, "pending");
    assert.equal(file.body.error.code, "ACCESS_NOT_GRANTED");
  });

  it("the patient sees who asks, why, and their own documents of that category", async () => {
    const res = await get(`/patient/access-requests/${S.reqLab}`, { token: S.patA.token });
    expectStatus(res, 200, "patient detail");
    assert.equal(res.data.doctor.id, String(S.docB.id));
    assert.equal(res.data.doctor.verified, true);
    assert.equal(res.data.purpose, "Second opinion on blood work");
    const ids = res.data.candidates.map((c) => c.id).sort();
    assert.deepEqual(ids, [S.records.lab1.id, S.records.lab2.id].sort(), "only the requested category");
  });

  it("refuses to share a record of another category or another patient", async () => {
    const wrongType = await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.patA.token, body: { recordIds: [S.records.rx1.id] } });
    expectStatus(wrongType, 400, "prescription under a lab request");
    const notMine = await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.patA.token, body: { recordIds: [S.records.labB.id] } });
    expectStatus(notMine, 400, "another patient's record");
    expectStatus(await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.patA.token, body: { recordIds: [] } }), 422, "nothing chosen");
  });

  it("approval shares EXACTLY the chosen document and notifies the doctor", async () => {
    const res = await post(`/patient/access-requests/${S.reqLab}/approve`, {
      token: S.patA.token,
      body: { recordIds: [S.records.lab1.id], durationDays: 7 },
    });
    expectStatus(res, 200, "approve");
    assert.equal(res.data.status, "approved");
    assert.deepEqual(res.data.sharedRecordIds, [S.records.lab1.id]);

    const again = await post(`/patient/access-requests/${S.reqLab}/approve`, { token: S.patA.token, body: { recordIds: [S.records.lab2.id] } });
    expectStatus(again, 409, "decide twice");

    const doc = await get(`/doctor/access-requests/${S.reqLab}`, { token: S.docB.token });
    expectStatus(doc, 200, "doctor detail");
    assert.equal(doc.data.active, true);
    assert.deepEqual(doc.data.records.map((r) => r.id), [S.records.lab1.id]);
    assert.equal(doc.data.records[0].fileUrl, undefined, "no storage URL is ever sent to the doctor");

    const feed = await get("/medicine/notifications", { token: S.docB.token });
    assert.ok(feed.data.notifications.some((n) => n.type === "record_access_approved" && String(n.referenceId) === S.reqLab));
  });

  it("streams the shared document privately, refuses the unshared one, and audits the read", async () => {
    const file = await get(`/doctor/access-requests/${S.reqLab}/records/${S.records.lab1.id}/file`, { token: S.docB.token });
    expectStatus(file, 200, "shared file");
    assert.ok(file.raw.toString().includes(`lab1 ${RUN}`), "the right file");
    assert.equal(file.headers.get("cache-control"), "private, no-store");

    const other = await get(`/doctor/access-requests/${S.reqLab}/records/${S.records.lab2.id}/file`, { token: S.docB.token });
    expectStatus(other, 403, "unshared lab report");
    const otherDoc = await get(`/doctor/access-requests/${S.reqLab}/records/${S.records.lab1.id}/file`, { token: S.docA.token });
    expectStatus(otherDoc, 404, "another doctor, same URL");

    const audit = await AccessAuditLog.count({ where: { doctorId: S.docB.id, action: "record_downloaded", entityId: S.records.lab1.id } });
    assert.equal(audit, 1);
  });

  it("revocation closes access immediately and notifies the doctor", async () => {
    expectStatus(await post(`/patient/access-requests/${S.reqLab}/revoke`, { token: S.patB.token }), 404, "other patient revokes");
    const res = await post(`/patient/access-requests/${S.reqLab}/revoke`, { token: S.patA.token });
    expectStatus(res, 200, "revoke");
    assert.equal(res.data.status, "revoked");
    expectStatus(await get(`/doctor/access-requests/${S.reqLab}/records/${S.records.lab1.id}/file`, { token: S.docB.token }), 403, "after revoke");
    const doc = await get(`/doctor/access-requests/${S.reqLab}`, { token: S.docB.token });
    assert.deepEqual(doc.data.records, [], "no document listed after revoke");
    const feed = await get("/medicine/notifications", { token: S.docB.token });
    assert.ok(feed.data.notifications.some((n) => n.type === "record_access_revoked"));
  });

  it("an expired grant no longer works", async () => {
    const create = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "prescription", purpose: "Medication reconciliation" },
    });
    expectStatus(create, 201, "create rx request");
    const approve = await post(`/patient/access-requests/${create.data.id}/approve`, { token: S.patA.token, body: { recordIds: [S.records.rx1.id] } });
    expectStatus(approve, 200, "approve rx");
    expectStatus(await get(`/doctor/access-requests/${create.data.id}/records/${S.records.rx1.id}/file`, { token: S.docB.token }), 200, "before expiry");

    await DoctorAccessRequest.update({ grantExpiresAt: new Date(Date.now() - 1000) }, { where: { id: create.data.id } });
    expectStatus(await get(`/doctor/access-requests/${create.data.id}/records/${S.records.rx1.id}/file`, { token: S.docB.token }), 403, "after expiry");
    const doc = await get(`/doctor/access-requests/${create.data.id}`, { token: S.docB.token });
    assert.equal(doc.data.status, "expired");
    assert.equal(await AccessAuditLog.count({ where: { entityId: create.data.id, action: "access_expired" } }), 1);
  });

  it("an unanswered request expires and can then be asked again", async () => {
    const create = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "xray", purpose: "Fracture follow-up review" },
    });
    expectStatus(create, 201, "create xray");
    await DoctorAccessRequest.update({ requestExpiresAt: new Date(Date.now() - 1000) }, { where: { id: create.data.id } });
    const late = await post(`/patient/access-requests/${create.data.id}/approve`, { token: S.patA.token, body: { recordIds: [S.records.lab1.id] } });
    expectStatus(late, 409, "approve an expired request");
    const again = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "xray", purpose: "Fracture follow-up review" },
    });
    expectStatus(again, 201, "ask again after expiry");
    S.reqXray = again.data.id;
  });

  it("rejection keeps everything closed and notifies the doctor", async () => {
    const res = await post(`/patient/access-requests/${S.reqXray}/reject`, { token: S.patA.token, body: { note: "Not now" } });
    expectStatus(res, 200, "reject");
    assert.equal(res.data.status, "rejected");
    const doc = await get(`/doctor/access-requests/${S.reqXray}`, { token: S.docB.token });
    assert.equal(doc.data.status, "rejected");
    assert.deepEqual(doc.data.records, []);
    const feed = await get("/medicine/notifications", { token: S.docB.token });
    assert.ok(feed.data.notifications.some((n) => n.type === "record_access_rejected" && String(n.referenceId) === S.reqXray));
  });

  it("the doctor can withdraw a pending request, but not a decided one", async () => {
    const create = await post("/doctor/access-requests", {
      token: S.docB.token,
      body: { patientId: S.patA.id, category: "mri", purpose: "Neurology second opinion" },
    });
    expectStatus(create, 201, "create mri");
    expectStatus(await post(`/doctor/access-requests/${create.data.id}/cancel`, { token: S.docA.token }), 404, "another doctor withdraws");
    const res = await post(`/doctor/access-requests/${create.data.id}/cancel`, { token: S.docB.token });
    expectStatus(res, 200, "withdraw");
    assert.equal(res.data.status, "cancelled");
    expectStatus(await post(`/doctor/access-requests/${S.reqXray}/cancel`, { token: S.docB.token }), 409, "withdraw a rejected one");
  });

  it("lists are scoped to their owner", async () => {
    const mine = await get("/patient/access-requests", { token: S.patA.token });
    expectStatus(mine, 200, "patient list");
    assert.ok(mine.data.total >= 4);
    const other = await get("/patient/access-requests", { token: S.patB.token });
    assert.equal(other.data.total, 0);
    const docList = await get(`/doctor/access-requests?patientId=${S.patA.id}`, { token: S.docB.token });
    assert.equal(docList.data.total, mine.data.total);
    assert.equal((await get("/doctor/access-requests", { token: S.docA.token })).data.total, 0);
  });

  it("audited every step of the lifecycle", async () => {
    const rows = await AccessAuditLog.findAll({ where: { doctorId: S.docB.id, patientId: S.patA.id }, attributes: ["action"] });
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["access_requested", "access_approved", "access_rejected", "access_revoked", "access_expired", "access_cancelled", "record_downloaded", "patient_basic_view"]) {
      assert.ok(actions.has(a), `audited ${a}`);
    }
  });
});
