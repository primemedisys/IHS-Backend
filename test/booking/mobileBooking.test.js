/**
 * Patient booking rules the mobile apps rely on — end-to-end against the LOCAL
 * test database (same harness as test/ambulance). Prepare it first:
 *   npm run test:db
 *
 * Covers:
 *  - the booking gate (PROFILE_INCOMPLETE until the required fields are set),
 *  - a successful video booking (dev payment bypass: no Razorpay keys in test),
 *  - the duplicate-booking guard (one live token per patient per session),
 *  - a cancelled booking frees the patient to book that day again,
 *  - portal separation: a doctor can't sign in with audience=patient, and a
 *    patient token can't reach /doctor routes (and vice versa).
 */
require("../testEnv");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../../src/app");
const { sequelize, DoctorProfile, DoctorOnlineAvailability, User } = require("../../src/models");

const RUN = Date.now().toString(36);
const PASSWORD = "Mobile#2026x";
let server;
let base;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json, data: json?.data };
}

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
}

/** Tomorrow as YYYY-MM-DD in server-local time (the session window is all day). */
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe("mobile patient booking rules", () => {
  let patientToken;
  let doctorToken;
  let doctorId;
  let firstBookingId;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    // A doctor, approved and listed, consulting by video every day.
    const reg = await call("POST", "/auth/register", {
      body: { name: `Dr Mobile ${RUN}`, email: `dr.mobile.${RUN}@ihs-test.example.com`, password: PASSWORD, role: "doctor" },
    });
    expectStatus(reg, 201, "register doctor");
    doctorToken = reg.data.tokens.accessToken;
    doctorId = Number(reg.data.user.id);
    const [profile] = await DoctorProfile.findOrCreate({
      where: { userId: doctorId },
      defaults: { userId: doctorId, registrationNumber: `REG-${RUN}` },
    });
    await profile.update({ verificationStatus: "approved", isListed: true, onlineFee: 400, registrationNumber: `REG-${RUN}` });
    await DoctorOnlineAvailability.bulkCreate(
      [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        doctorId,
        dayOfWeek,
        startTime: "00:00:00",
        endTime: "23:59:00",
        slotDurationMinutes: 15,
      }))
    );

    // A patient, registered through the public endpoint like the app does.
    const pr = await call("POST", "/auth/register", {
      body: { name: `Patient ${RUN}`, email: `patient.mobile.${RUN}@ihs-test.example.com`, password: PASSWORD, role: "patient" },
    });
    expectStatus(pr, 201, "register patient");
    patientToken = pr.data.tokens.accessToken;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  });

  it("refuses a booking until the required profile fields are complete", async () => {
    const res = await call("POST", "/patient/bookings", {
      token: patientToken,
      body: { doctorId, mode: "video", date: tomorrow(), paymentMode: "online" },
    });
    expectStatus(res, 409, "incomplete profile");
    assert.equal(res.body.error.code, "PROFILE_INCOMPLETE");
    assert.deepEqual([...res.body.error.details.missing].sort(), ["city", "dateOfBirth", "gender", "phone"]);
  });

  it("completes the profile and reports completion", async () => {
    const res = await call("PUT", "/patient/profile", {
      token: patientToken,
      body: { phone: "9876543210", dateOfBirth: "1990-05-17", gender: "female", city: "Bhubaneswar" },
    });
    expectStatus(res, 200, "update profile");
    assert.equal(res.data.status.complete, true);
    assert.equal(res.data.completion.percent, 60);
  });

  it("books a video consultation", async () => {
    const res = await call("POST", "/patient/bookings", {
      token: patientToken,
      body: { doctorId, mode: "video", date: tomorrow(), paymentMode: "online" },
    });
    expectStatus(res, 201, "create booking");
    const booking = res.data.booking ?? res.data;
    assert.equal(booking.status, "confirmed");
    assert.equal(booking.queueNumber, 1);
    firstBookingId = booking.id;
  });

  it("rejects a second live booking in the same session (DUPLICATE_BOOKING)", async () => {
    const res = await call("POST", "/patient/bookings", {
      token: patientToken,
      body: { doctorId, mode: "video", date: tomorrow(), paymentMode: "online" },
    });
    expectStatus(res, 409, "duplicate booking");
    assert.equal(res.body.error.code, "DUPLICATE_BOOKING");
    assert.equal(res.body.error.details.bookingId, firstBookingId);
  });

  it("serialises concurrent submits so only one token is issued", async () => {
    // Cancel the first booking, then fire two submits at once (a double tap).
    expectStatus(await call("POST", `/patient/bookings/${firstBookingId}/cancel`, { token: patientToken, body: {} }), 200, "cancel");
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        call("POST", "/patient/bookings", {
          token: patientToken,
          body: { doctorId, mode: "video", date: tomorrow(), paymentMode: "online" },
        })
      )
    );
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected one success and one duplicate, got ${statuses}`);
    const list = await call("GET", "/patient/bookings", { token: patientToken });
    const live = list.data.filter((x) => ["confirmed", "pending_payment"].includes(x.status));
    assert.equal(live.length, 1);
  });

  it("refuses a doctor account on the patient portal (WRONG_PORTAL)", async () => {
    const user = await User.findByPk(doctorId);
    const res = await call("POST", "/auth/login", { body: { email: user.email, password: PASSWORD, audience: "patient" } });
    expectStatus(res, 403, "doctor on patient portal");
    assert.equal(res.body.error.code, "WRONG_PORTAL");
  });

  it("keeps patient and doctor APIs separate by role", async () => {
    expectStatus(await call("GET", "/doctor/bookings", { token: patientToken }), 403, "patient → doctor route");
    expectStatus(await call("GET", "/patient/profile", { token: doctorToken }), 403, "doctor → patient route");
    expectStatus(await call("GET", "/patient/profile"), 401, "anonymous → patient route");
  });
});
