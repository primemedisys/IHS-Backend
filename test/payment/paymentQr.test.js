/**
 * Provider UPI QR payments (migration 044) — end-to-end API tests.
 *
 * Real HTTP, no mocks. Covers:
 *  - provider QR CRUD for a doctor and a pharmacy, ownership (always the
 *    caller's own row), role separation, image type rejection;
 *  - GET /doctors/:id/payment-options (public, never exposes the QR);
 *  - doctor bookings paid by UPI QR (clinic AND video): confirmed booking +
 *    pending_at_clinic payment + offline_method upi_qr; 409 when the doctor has
 *    no QR; the patient's payment report never changes any status; completing
 *    does NOT settle a UPI payment; mark-paid does; ownership (404);
 *  - medicine checkout by UPI QR: visible to the pharmacy at once, not paid on
 *    delivery, confirm-received settles it, another pharmacy / patient can't.
 *
 * Two ways to run (same as test/pharmacy):
 *   1. In-process app against the LOCAL `_test` database:
 *        npm run test:db && npm test
 *   2. Against an already-running API (writes tagged test data into THAT
 *      server's database; the run's accounts are deactivated at the end):
 *        PAYMENT_E2E_BASE_URL=http://localhost:5055 node --test test/payment/paymentQr.test.js
 */
const path = require("path");

const EXTERNAL = process.env.PAYMENT_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  // Only the DB connection (for fixtures/assertions) comes from .env.
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  sequelize,
  User,
  DoctorProfile,
  DoctorOnlineAvailability,
  Clinic,
  ClinicAvailability,
  Payment,
  MedicinePayment,
} = require("../../src/models");

const RUN = Date.now().toString(36);
const PASSWORD = "PayQr#2026x";
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
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);
const del = (p, o) => call("DELETE", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

/** A 1×1 PNG, for QR uploads. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const fileForm = (buffer, name, type) => {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  return form;
};

/** Tomorrow as YYYY-MM-DD in server-local time (the session windows are all day). */
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const email = (who) => `payqr-${who}-${RUN}@ihs-test.example.com`;
async function register(who, role, extra = {}) {
  const res = await post("/auth/register", {
    body: { name: `${who} ${RUN}`, email: email(who), password: PASSWORD, role, ...extra },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: Number(res.data.user.id), token: res.data.tokens.accessToken };
}

const S = {};

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) {
    base = EXTERNAL.replace(/\/+$/, "");
  } else {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  // Two doctors, approved + listed, consulting by video and at one clinic every day.
  for (const key of ["docA", "docB"]) {
    S[key] = await register(key, "doctor");
    const [profile] = await DoctorProfile.findOrCreate({
      where: { userId: S[key].id },
      defaults: { userId: S[key].id, registrationNumber: `REG-${key}-${RUN}` },
    });
    await profile.update({ verificationStatus: "approved", isListed: true, onlineFee: 400, registrationNumber: `REG-${key}-${RUN}` });
    await DoctorOnlineAvailability.bulkCreate(
      [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: S[key].id, dayOfWeek, startTime: "00:00:00", endTime: "23:59:00", slotDurationMinutes: 15 }))
    );
    const clinic = await Clinic.create({
      doctorId: S[key].id,
      name: `QR Clinic ${key} ${RUN}`,
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
    S[key].clinicId = Number(clinic.id);
  }

  // Two patients with complete profiles (the booking gate).
  for (const key of ["patA", "patB"]) {
    S[key] = await register(key, "patient");
    const prof = await put("/patient/profile", {
      token: S[key].token,
      body: { phone: "9876543210", dateOfBirth: "1990-05-17", gender: "female", city: "Bhubaneswar" },
    });
    expectStatus(prof, 200, `profile ${key}`);
  }

  // Two pharmacies, each with one medicine in stock.
  for (const [key, role] of [["storeA", "medicine_store"], ["storeB", "pharmacy_hospital"]]) {
    S[key] = await register(key, role, { phone: "9876543210", city: `Qrpur${RUN}`, state: "Odisha" });
    const med = await post("/medicine/my-medicines", {
      token: S[key].token,
      body: { medicineName: `QrMed ${key} ${RUN}`, medicineType: "tablet", strength: "500 mg", price: 50, stock: 100 },
    });
    expectStatus(med, 201, `${key} adds medicine`);
    S[key].medicineId = med.data.medicine.id;
  }
});

after(async () => {
  // Remove the run's QR rows + uploaded image files through the API itself.
  if (S.docA?.token) await del("/doctor/payment-qr", { token: S.docA.token });
  if (S.storeA?.token) await del("/medicine/pharmacy/payment-qr", { token: S.storeA.token });
  if (EXTERNAL) {
    // Keep the shared database clean for real users.
    const ids = ["docA", "docB", "patA", "patB", "storeA", "storeB"].map((k) => S[k]?.id).filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Provider payment QR — management", () => {
  it("a doctor starts with an empty, unconfigured QR", async () => {
    const res = await get("/doctor/payment-qr", { token: S.docA.token });
    expectStatus(res, 200, "get empty");
    assert.deepEqual(res.data, { upiId: null, payeeName: null, qrImageUrl: null, isActive: false, updatedAt: null, configured: false });
  });

  it("validates the UPI ID and payee name", async () => {
    expectStatus(await put("/doctor/payment-qr", { token: S.docA.token, body: { upiId: "not-a-upi" } }), 422, "bad upi");
    expectStatus(await put("/doctor/payment-qr", { token: S.docA.token, body: { payeeName: "A" } }), 422, "short payee");
    expectStatus(await put("/doctor/payment-qr", { token: S.docA.token, body: {} }), 422, "empty body");
  });

  it("saves text fields first; not configured until an image exists", async () => {
    const res = await put("/doctor/payment-qr", { token: S.docA.token, body: { upiId: "dr.a@okaxis", payeeName: "Dr A Clinic" } });
    expectStatus(res, 200, "put");
    assert.equal(res.data.upiId, "dr.a@okaxis");
    assert.equal(res.data.payeeName, "Dr A Clinic");
    assert.equal(res.data.isActive, true);
    assert.equal(res.data.configured, false);
  });

  it("rejects non-image / unsupported image uploads", async () => {
    const pdf = await post("/doctor/payment-qr/image", { token: S.docA.token, form: fileForm(Buffer.from("%PDF-1.4"), "qr.pdf", "application/pdf") });
    expectStatus(pdf, 422, "pdf");
    assert.equal(pdf.body.error.code, "UNSUPPORTED_FILE_TYPE");
    const gif = await post("/doctor/payment-qr/image", { token: S.docA.token, form: fileForm(PNG, "qr.gif", "image/gif") });
    expectStatus(gif, 422, "gif");
    assert.equal(gif.body.error.code, "UNSUPPORTED_FILE_TYPE");
    const big = await post("/doctor/payment-qr/image", { token: S.docA.token, form: fileForm(Buffer.alloc(2 * 1024 * 1024 + 10), "qr.png", "image/png") });
    expectStatus(big, 422, "too large");
  });

  it("uploads, then replaces, the QR image", async () => {
    const first = await post("/doctor/payment-qr/image", { token: S.docA.token, form: fileForm(PNG, "qr.png", "image/png") });
    expectStatus(first, 200, "upload");
    assert.ok(first.data.qrImageUrl.includes(`/payment-qr/${S.docA.id}/`), "stored under payment-qr/<userId>");
    assert.equal(first.data.configured, true);
    const second = await post("/doctor/payment-qr/image", { token: S.docA.token, form: fileForm(PNG, "qr2.webp", "image/webp") });
    expectStatus(second, 200, "replace");
    assert.notEqual(second.data.qrImageUrl, first.data.qrImageUrl);
    assert.equal(second.data.upiId, "dr.a@okaxis", "text fields survive an image replace");
  });

  it("each provider only ever sees and edits its OWN row", async () => {
    const b = await get("/doctor/payment-qr", { token: S.docB.token });
    expectStatus(b, 200, "doc B get");
    assert.equal(b.data.configured, false, "doctor B does not see doctor A's QR");
    // A body can't redirect the write to another user — unknown keys are stripped.
    await put("/doctor/payment-qr", { token: S.docB.token, body: { userId: S.docA.id, upiId: "dr.b@okicici" } });
    const a = await get("/doctor/payment-qr", { token: S.docA.token });
    assert.equal(a.data.upiId, "dr.a@okaxis", "doctor A's row untouched");
  });

  it("keeps the QR routes to their own roles", async () => {
    expectStatus(await get("/doctor/payment-qr", { token: S.patA.token }), 403, "patient → doctor QR");
    expectStatus(await put("/doctor/payment-qr", { token: S.patA.token, body: { upiId: "x.y@okaxis" } }), 403, "patient → doctor QR put");
    expectStatus(await get("/medicine/pharmacy/payment-qr", { token: S.patA.token }), 403, "patient → pharmacy QR");
    expectStatus(await get("/medicine/pharmacy/payment-qr", { token: S.docA.token }), 403, "doctor → pharmacy QR");
    expectStatus(await get("/doctor/payment-qr", { token: S.storeA.token }), 403, "pharmacy → doctor QR");
    expectStatus(await get("/doctor/payment-qr"), 401, "anonymous");
  });

  it("deleting removes the row (and its image)", async () => {
    await post("/doctor/payment-qr/image", { token: S.docB.token, form: fileForm(PNG, "qr.png", "image/png") });
    const res = await del("/doctor/payment-qr", { token: S.docB.token });
    expectStatus(res, 200, "delete");
    assert.equal(res.data.configured, false);
    assert.equal(res.data.qrImageUrl, null);
    assert.equal((await get("/doctor/payment-qr", { token: S.docB.token })).data.upiId, null);
  });

  it("pharmacies manage their own QR the same way", async () => {
    for (const key of ["storeA"]) {
      const up = await post("/medicine/pharmacy/payment-qr/image", { token: S[key].token, form: fileForm(PNG, "qr.jpg", "image/jpeg") });
      expectStatus(up, 200, `${key} upload`);
      const put1 = await put("/medicine/pharmacy/payment-qr", { token: S[key].token, body: { upiId: "store.a@oksbi", payeeName: "Store A Pharmacy" } });
      expectStatus(put1, 200, `${key} put`);
      assert.equal(put1.data.configured, true);
    }
    const b = await get("/medicine/pharmacy/payment-qr", { token: S.storeB.token });
    expectStatus(b, 200, "store B get");
    assert.equal(b.data.configured, false);
  });
});

describe("Doctor bookings paid by UPI QR", () => {
  it("payment-options says whether the doctor takes UPI QR — and never exposes it", async () => {
    const a = await get(`/doctors/${S.docA.id}/payment-options`);
    expectStatus(a, 200, "options A");
    assert.equal(a.data.cashAtClinic, true);
    assert.equal(a.data.upiQr, true);
    assert.equal(typeof a.data.onlineGateway, "boolean");
    assert.equal(typeof a.data.testModeAutoConfirm, "boolean");
    assert.ok(!JSON.stringify(a.data).includes("okaxis"), "no UPI id in the public options");
    const b = await get(`/doctors/${S.docB.id}/payment-options`);
    assert.equal(b.data.upiQr, false);
    expectStatus(await get("/doctors/999999999/payment-options"), 404, "unknown doctor");
    expectStatus(await get("/doctors/abc/payment-options"), 422, "non-numeric id");
  });

  it("refuses upi_qr when the doctor has no QR (409 PAYMENT_QR_UNAVAILABLE), and upi_qr with online", async () => {
    const res = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docB.id, mode: "clinic", clinicId: S.docB.clinicId, date: tomorrow(), paymentMode: "offline", offlineMethod: "upi_qr" },
    });
    expectStatus(res, 409, "no QR");
    assert.equal(res.body.error.code, "PAYMENT_QR_UNAVAILABLE");
    const online = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docA.id, mode: "clinic", clinicId: S.docA.clinicId, date: tomorrow(), paymentMode: "online", offlineMethod: "upi_qr" },
    });
    expectStatus(online, 422, "upi_qr needs offline");
  });

  it("books a clinic visit by UPI QR → confirmed + pending_at_clinic + upi_qr", async () => {
    const res = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docA.id, mode: "clinic", clinicId: S.docA.clinicId, date: tomorrow(), paymentMode: "offline", offlineMethod: "upi_qr" },
    });
    expectStatus(res, 201, "clinic upi booking");
    const b = res.data.booking ?? res.data;
    assert.equal(b.status, "confirmed");
    assert.equal(b.paymentMode, "offline");
    assert.equal(b.payment.status, "pending_at_clinic");
    assert.equal(b.payment.mode, "offline");
    assert.equal(b.payment.offlineMethod, "upi_qr");
    assert.equal(b.payment.reportedAt, null);
    S.clinicBookingId = b.id;
    const row = await Payment.findOne({ where: { bookingId: b.id } });
    assert.equal(row.offlineMethod, "upi_qr");
  });

  it("books a VIDEO consult by UPI QR (no longer forced online)", async () => {
    const res = await post("/patient/bookings", {
      token: S.patA.token,
      body: { doctorId: S.docA.id, mode: "video", date: tomorrow(), paymentMode: "offline", offlineMethod: "upi_qr" },
    });
    expectStatus(res, 201, "video upi booking");
    const b = res.data.booking ?? res.data;
    assert.equal(b.mode, "video");
    assert.equal(b.status, "confirmed");
    assert.equal(b.paymentMode, "offline");
    assert.equal(b.payment.status, "pending_at_clinic");
    assert.equal(b.payment.offlineMethod, "upi_qr");
    S.videoBookingId = b.id;
  });

  it("still forces a video + cash booking online", async () => {
    const res = await post("/patient/bookings", {
      token: S.patB.token,
      body: { doctorId: S.docA.id, mode: "video", date: tomorrow(), paymentMode: "offline" },
    });
    expectStatus(res, 201, "video cash → online");
    const b = res.data.booking ?? res.data;
    assert.equal(b.paymentMode, "online");
    assert.equal(b.payment.offlineMethod, null);
    S.patBVideoBookingId = b.id;
  });

  it("gives the patient the doctor's QR, amount and reference", async () => {
    const res = await get(`/patient/bookings/${S.clinicBookingId}/payment-qr`, { token: S.patA.token });
    expectStatus(res, 200, "payment-qr");
    assert.equal(res.data.payee.name, "Dr A Clinic");
    assert.equal(res.data.payee.upiId, "dr.a@okaxis");
    assert.ok(res.data.payee.qrImageUrl);
    assert.equal(res.data.amount, 300);
    assert.equal(res.data.currency, "INR");
    assert.equal(res.data.reference, `IHS-BK-${S.clinicBookingId}`);
    assert.equal(res.data.paymentStatus, "pending_at_clinic");
    assert.equal(res.data.offlineMethod, "upi_qr");
  });

  it("hides another patient's booking (404) and non-QR bookings (409)", async () => {
    expectStatus(await get(`/patient/bookings/${S.clinicBookingId}/payment-qr`, { token: S.patB.token }), 404, "B reads A's");
    expectStatus(await post(`/patient/bookings/${S.clinicBookingId}/payment-report`, { token: S.patB.token, body: {} }), 404, "B reports A's");
    const online = await get(`/patient/bookings/${S.patBVideoBookingId}/payment-qr`, { token: S.patB.token });
    expectStatus(online, 409, "online booking");
    assert.equal(online.body.error.code, "PAYMENT_QR_UNAVAILABLE");
    expectStatus(await get(`/patient/bookings/${S.clinicBookingId}/payment-qr`, { token: S.docA.token }), 403, "doctor on patient route");
  });

  it("records the patient's payment report WITHOUT changing any status", async () => {
    expectStatus(await post(`/patient/bookings/${S.clinicBookingId}/payment-report`, { token: S.patA.token, body: { reference: "bad ref!" } }), 422, "bad ref");
    const res = await post(`/patient/bookings/${S.clinicBookingId}/payment-report`, { token: S.patA.token, body: { reference: "UTR123456789" } });
    expectStatus(res, 200, "report");
    assert.equal(res.data.payerReference, "UTR123456789");
    assert.ok(res.data.reportedAt);
    assert.equal(res.data.paymentStatus, "pending_at_clinic");
    const again = await post(`/patient/bookings/${S.clinicBookingId}/payment-report`, { token: S.patA.token, body: { reference: "UTR999999999" } });
    expectStatus(again, 200, "re-report");
    assert.equal(again.data.payerReference, "UTR999999999", "re-reporting overwrites the reference");

    const mine = await get(`/patient/bookings/${S.clinicBookingId}`, { token: S.patA.token });
    assert.equal(mine.data.status, "confirmed");
    assert.equal(mine.data.payment.status, "pending_at_clinic");
    assert.equal(mine.data.payment.payerReference, "UTR999999999");

    // The doctor sees the report on their booking views.
    const list = await get("/doctor/bookings", { token: S.docA.token });
    const row = list.data.find((x) => x.id === S.clinicBookingId);
    assert.equal(row.payment.offlineMethod, "upi_qr");
    assert.equal(row.payment.payerReference, "UTR999999999");
    assert.ok(row.payment.reportedAt);
    const one = await get(`/doctor/bookings/${S.clinicBookingId}`, { token: S.docA.token });
    assert.equal(one.data.booking.payment.offlineMethod, "upi_qr");
  });

  it("completing the consult does NOT settle a UPI payment; mark-paid does", async () => {
    const done = await post(`/doctor/bookings/${S.clinicBookingId}/complete`, { token: S.docA.token, body: {} });
    expectStatus(done, 200, "complete");
    assert.equal(done.data.status, "completed");
    assert.equal(done.data.payment.status, "pending_at_clinic", "UPI stays pending until the doctor confirms");

    const paid = await post(`/doctor/bookings/${S.clinicBookingId}/mark-paid`, { token: S.docA.token });
    expectStatus(paid, 200, "mark-paid");
    assert.equal(paid.data.payment.status, "success");
    const row = await Payment.findOne({ where: { bookingId: S.clinicBookingId } });
    assert.equal(row.status, "success");
    assert.ok(row.paidAt);
    assert.ok(Number(row.doctorPayoutAmount) > 0, "commission split stamped");

    const late = await post(`/patient/bookings/${S.clinicBookingId}/payment-report`, { token: S.patA.token, body: {} });
    expectStatus(late, 409, "report after paid");
    assert.equal(late.body.error.code, "PAYMENT_NOT_PENDING");
  });

  it("mark-paid settles the video UPI booking too; another doctor can't", async () => {
    expectStatus(await post(`/doctor/bookings/${S.videoBookingId}/mark-paid`, { token: S.docB.token }), 404, "doctor B");
    const paid = await post(`/doctor/bookings/${S.videoBookingId}/mark-paid`, { token: S.docA.token });
    expectStatus(paid, 200, "mark-paid video");
    assert.equal(paid.data.payment.status, "success");
    assert.equal(paid.data.payment.offlineMethod, "upi_qr");
  });

  it("409s the patient's QR read once the doctor removes the QR", async () => {
    // A fresh UPI booking for patient B at the clinic, then the doctor turns the QR off.
    const res = await post("/patient/bookings", {
      token: S.patB.token,
      body: { doctorId: S.docA.id, mode: "clinic", clinicId: S.docA.clinicId, date: tomorrow(), paymentMode: "offline", offlineMethod: "upi_qr" },
    });
    expectStatus(res, 201, "B clinic upi");
    const id = (res.data.booking ?? res.data).id;
    expectStatus(await put("/doctor/payment-qr", { token: S.docA.token, body: { isActive: false } }), 200, "deactivate");
    const qr = await get(`/patient/bookings/${id}/payment-qr`, { token: S.patB.token });
    expectStatus(qr, 409, "QR gone");
    assert.equal(qr.body.error.code, "PAYMENT_QR_UNAVAILABLE");
    assert.equal((await get(`/doctors/${S.docA.id}/payment-options`)).data.upiQr, false);
    expectStatus(await put("/doctor/payment-qr", { token: S.docA.token, body: { isActive: true } }), 200, "reactivate");
  });
});

describe("Medicine orders paid by UPI QR", () => {
  it("cart payment-options reflect every pharmacy's QR", async () => {
    expectStatus(await post("/medicine/cart/items", { token: S.patA.token, body: { medicineId: S.storeA.medicineId, quantity: 2 } }), 201, "cart A");
    let opts = await get("/medicine/cart/payment-options", { token: S.patA.token });
    expectStatus(opts, 200, "options");
    assert.equal(opts.data.cod, true);
    assert.equal(opts.data.upiQr, true);
    assert.deepEqual(opts.data.providers.map((p) => [p.providerId, p.upiQr]), [[S.storeA.id, true]]);

    expectStatus(await post("/medicine/cart/items", { token: S.patA.token, body: { medicineId: S.storeB.medicineId, quantity: 1 } }), 201, "cart B");
    opts = await get("/medicine/cart/payment-options", { token: S.patA.token });
    assert.equal(opts.data.upiQr, false, "store B has no QR");
  });

  it("refuses a UPI QR checkout when any pharmacy lacks a QR — and creates nothing", async () => {
    const res = await post("/medicine/orders/checkout", {
      token: S.patA.token,
      body: { paymentMethod: "upi_qr", deliveryAddress: "12 Test Lane, Qrpur" },
    });
    expectStatus(res, 409, "mixed cart");
    assert.equal(res.body.error.code, "PAYMENT_QR_UNAVAILABLE");
    const cart = await get("/medicine/cart", { token: S.patA.token });
    assert.equal(cart.data.cart.items.length, 2, "cart untouched");
  });

  it("places a UPI QR order that the pharmacy sees at once, unpaid", async () => {
    const lines = (await get("/medicine/cart", { token: S.patA.token })).data.cart.items;
    const lineA = lines.find((l) => Number(l.medicineId ?? l.medicine?.id) === Number(S.storeA.medicineId)) ?? lines[0];
    const res = await post("/medicine/orders/checkout", {
      token: S.patA.token,
      body: { itemIds: [lineA.id], paymentMethod: "upi_qr", deliveryAddress: "12 Test Lane, Qrpur" },
    });
    expectStatus(res, 201, "checkout upi");
    assert.equal(res.data.requiresPayment, false, "old clients must not open the simulated pay screen");
    assert.equal(res.data.paymentInstructions, "upi_qr");
    const g = res.data.groups[0];
    assert.equal(g.paymentMethod, "upi_qr");
    assert.equal(g.paymentStatus, "pending");
    assert.deepEqual(g.payment, { method: "upi_qr", status: "pending", payerReference: null, reportedAt: null });
    assert.ok(g.placedAt, "live from checkout");
    S.groupId = g.id;
    S.orderNumber = g.orderNumber;
    const mp = await MedicinePayment.findOne({ where: { orderGroupId: g.id } });
    assert.equal(mp.method, "upi_qr");
    assert.equal(mp.gateway, "manual_upi");
    assert.equal(mp.status, "pending");

    const list = await get(`/medicine/orders/groups/provider?search=${g.orderNumber}`, { token: S.storeA.token });
    expectStatus(list, 200, "pharmacy list");
    assert.equal(list.data.orders.length, 1, "visible to the pharmacy immediately");
    const filtered = await get(`/medicine/orders/groups/provider?paymentMethod=upi_qr&search=${g.orderNumber}`, { token: S.storeA.token });
    assert.equal(filtered.data.orders.length, 1, "filterable by upi_qr");
  });

  it("gives the patient the pharmacy's QR; other patients can't read it", async () => {
    const res = await get(`/medicine/orders/groups/${S.groupId}/payment-qr`, { token: S.patA.token });
    expectStatus(res, 200, "payment-qr");
    assert.equal(res.data.payee.name, "Store A Pharmacy");
    assert.equal(res.data.payee.upiId, "store.a@oksbi");
    assert.equal(res.data.amount, 100);
    assert.equal(res.data.reference, S.orderNumber);
    assert.equal(res.data.paymentStatus, "pending");
    assert.ok(!("offlineMethod" in res.data));
    expectStatus(await get(`/medicine/orders/groups/${S.groupId}/payment-qr`, { token: S.patB.token }), 403, "patient B");
    expectStatus(await post(`/medicine/orders/groups/${S.groupId}/payment-report`, { token: S.patB.token, body: {} }), 403, "patient B report");
  });

  it("records the patient's report without changing any status", async () => {
    const res = await post(`/medicine/orders/groups/${S.groupId}/payment-report`, { token: S.patA.token, body: { reference: "UPI-REF-778899" } });
    expectStatus(res, 200, "report");
    assert.equal(res.data.payerReference, "UPI-REF-778899");
    assert.ok(res.data.reportedAt);
    assert.equal(res.data.paymentStatus, "pending");
    const { order } = (await get(`/medicine/orders/groups/${S.groupId}`, { token: S.storeA.token })).data;
    assert.equal(order.paymentStatus, "pending");
    assert.equal(order.payment.payerReference, "UPI-REF-778899");
  });

  it("does NOT mark a UPI QR order paid on delivery", async () => {
    for (const status of ["confirmed", "processing", "shipped", "delivered"]) {
      const res = await put(`/medicine/orders/groups/${S.groupId}/status`, { token: S.storeA.token, body: { status } });
      expectStatus(res, 200, `→ ${status}`);
    }
    const { order } = (await get(`/medicine/orders/groups/${S.groupId}`, { token: S.patA.token })).data;
    assert.equal(order.status, "delivered");
    assert.equal(order.paymentStatus, "pending", "delivery is not proof of a UPI transfer");
  });

  it("only the order's own pharmacy can confirm receipt; then it is paid", async () => {
    expectStatus(await post(`/medicine/orders/groups/${S.groupId}/payment/confirm-received`, { token: S.storeB.token }), 403, "other pharmacy");
    expectStatus(await post(`/medicine/orders/groups/${S.groupId}/payment/confirm-received`, { token: S.patA.token }), 403, "patient");
    const res = await post(`/medicine/orders/groups/${S.groupId}/payment/confirm-received`, { token: S.storeA.token });
    expectStatus(res, 200, "confirm");
    assert.equal(res.data.order.paymentStatus, "paid");
    assert.equal(res.data.order.payment.status, "paid");
    const mp = await MedicinePayment.findOne({ where: { orderGroupId: S.groupId } });
    assert.equal(mp.status, "success");
    assert.ok(mp.paidAt);
    assert.equal(mp.reference, "UPI-REF-778899", "the patient's reported reference");
    const again = await post(`/medicine/orders/groups/${S.groupId}/payment/confirm-received`, { token: S.storeA.token });
    expectStatus(again, 409, "already paid");
    assert.equal(again.body.error.code, "PAYMENT_NOT_PENDING");
  });

  it("confirm-received refuses a COD order", async () => {
    const res = await post("/medicine/orders", {
      token: S.patB.token,
      body: { medicineId: S.storeA.medicineId, quantity: 1, paymentMethod: "cod", deliveryAddress: "12 Test Lane, Qrpur" },
    });
    expectStatus(res, 201, "cod order");
    const confirm = await post(`/medicine/orders/groups/${res.data.group.id}/payment/confirm-received`, { token: S.storeA.token });
    expectStatus(confirm, 409, "cod confirm");
    assert.equal(confirm.body.error.code, "ORDER_NOT_PAYABLE");
    const qr = await get(`/medicine/orders/groups/${res.data.group.id}/payment-qr`, { token: S.patB.token });
    expectStatus(qr, 409, "cod payment-qr");
    assert.equal(qr.body.error.code, "PAYMENT_QR_UNAVAILABLE");
  });

  it("a direct (single-medicine) order accepts upi_qr too", async () => {
    const res = await post("/medicine/orders", {
      token: S.patB.token,
      body: { medicineId: S.storeA.medicineId, quantity: 1, paymentMethod: "upi_qr", deliveryAddress: "12 Test Lane, Qrpur" },
    });
    expectStatus(res, 201, "direct upi order");
    assert.equal(res.data.group.paymentMethod, "upi_qr");
    assert.equal(res.data.requiresPayment, false);
    const noQr = await post("/medicine/orders", {
      token: S.patB.token,
      body: { medicineId: S.storeB.medicineId, quantity: 1, paymentMethod: "upi_qr", deliveryAddress: "12 Test Lane, Qrpur" },
    });
    expectStatus(noQr, 409, "store B has no QR");
    assert.equal(noQr.body.error.code, "PAYMENT_QR_UNAVAILABLE");
  });
});
