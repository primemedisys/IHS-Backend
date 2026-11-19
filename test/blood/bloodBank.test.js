/**
 * Blood Bank module — end-to-end API tests against the LOCAL test database.
 *
 * Runs the real Express app in-process over HTTP (no mocks), so every layer is
 * exercised: validation → auth → role gate → approval gate → service →
 * transaction → DB. Prepare the DB first:  npm run test:db
 *
 * The scenarios run in order and share state (one blood bank's life story):
 * register → approve → donor → screening → donation → tests → release →
 * patient request → reserve → cross-match → approve → issue → completion.
 */
require("../testEnv");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../../src/app");
const { sequelize, BloodUnit, MedicineNotification, BloodAuditLog } = require("../../src/models");

const RUN = Date.now().toString(36);
let server;
let base;

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
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

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
}

// Shared state across the ordered scenarios.
const S = {};
const CITY = `Testpur${RUN}`;
const STATE = "Test State";

before(async () => {
  await sequelize.authenticate();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Blood Bank module", () => {
  it("1. registers a blood bank (pending verification)", async () => {
    const res = await post("/auth/blood-bank/register", {
      body: {
        name: `Life Blood Centre ${RUN}`,
        email: `bank-${RUN}@test.local`,
        phone: "9876500001",
        password: "BloodBank123",
        centreType: "standalone",
        contactPerson: "Dr Rao",
        licenseNumber: `LIC-${RUN}`,
        emergencyPhone: "9876500002",
        operatingHours: "24x7",
        is24x7: true,
        componentsOffered: ["whole_blood", "prbc", "platelets", "plasma"],
        addressLine: "1 Test Road",
        city: CITY,
        state: STATE,
        pincode: "751001",
        lat: 20.2961,
        lng: 85.8245,
      },
    });
    expectStatus(res, 201, "register");
    assert.equal(res.data.user.role, "blood_bank");
    assert.equal(res.data.profile.verificationStatus, "pending");
    S.bankId = res.data.user.id;
  });

  it("2. logs the blood bank in; pending banks are kept out of operations", async () => {
    const bad = await post("/auth/blood-bank/login", { body: { email: `bank-${RUN}@test.local`, password: "wrong-pass1" } });
    expectStatus(bad, 401, "wrong password");
    const res = await post("/auth/blood-bank/login", { body: { email: `bank-${RUN}@test.local`, password: "BloodBank123" } });
    expectStatus(res, 200, "login");
    S.bankToken = res.data.tokens.accessToken;

    const profile = await get("/blood-bank/profile", { token: S.bankToken });
    expectStatus(profile, 200, "pending bank can read its profile");
    const gated = await get("/blood-bank/dashboard", { token: S.bankToken });
    expectStatus(gated, 403, "pending bank cannot operate");
  });

  it("3. rejects unauthorized access (no token, wrong role, wrong portal)", async () => {
    expectStatus(await get("/blood-bank/donors"), 401, "no token");

    const patient = await post("/auth/register", {
      body: { name: `Pat ${RUN}`, email: `pat-${RUN}@test.local`, password: "Patient123", role: "patient", phone: "9000000001" },
    });
    expectStatus(patient, 201, "patient register");
    S.patientId = patient.data.user.id;
    S.patientToken = patient.data.tokens.accessToken;

    expectStatus(await get("/blood-bank/donors", { token: S.patientToken }), 403, "patient on bank route");
    const wrongPortal = await post("/auth/blood-bank/login", { body: { email: `pat-${RUN}@test.local`, password: "Patient123" } });
    expectStatus(wrongPortal, 401, "patient on blood-bank login");

    // Admin approves the bank (existing admin login).
    const admin = await post("/auth/admin/login", { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
    expectStatus(admin, 200, "admin login");
    S.adminToken = admin.data.tokens.accessToken;
    expectStatus(await get("/admin/blood-banks/summary", { token: S.bankToken }), 403, "bank on admin route");

    const verify = await post(`/admin/blood-banks/${S.bankId}/verify`, { token: S.adminToken, body: { decision: "approved" } });
    expectStatus(verify, 200, "admin approve");
    assert.equal(verify.data.bank.verificationStatus, "approved");
    expectStatus(await get("/blood-bank/dashboard", { token: S.bankToken }), 200, "approved bank operates");
  });

  it("4. creates a donor with a server-generated donor code", async () => {
    const res = await post("/blood-bank/donors", {
      token: S.bankToken,
      body: { name: "Ravi Donor", phone: "9111111111", gender: "male", dateOfBirth: "1990-05-01", bloodGroup: "O+", consentGiven: true, city: CITY },
    });
    expectStatus(res, 201, "create donor");
    assert.match(res.data.donor.donorCode, /^DNR-\d{4}-\d{6}$/);
    S.donorId = res.data.donor.id;

    const invalid = await post("/blood-bank/donors", { token: S.bankToken, body: { name: "X" } });
    expectStatus(invalid, 422, "donor validation");
  });

  it("5. records screening (staff decision) and a donation", async () => {
    // A deferral blocks donation.
    const deferral = await post(`/blood-bank/donors/${S.donorId}/screenings`, {
      token: S.bankToken,
      body: { decision: "deferred_temporary", deferralReason: "Low haemoglobin", deferredUntil: "2099-01-01", screenedByName: "Dr Rao", hemoglobinGdl: 11.2 },
    });
    expectStatus(deferral, 201, "deferral screening");
    const blocked = await post("/blood-bank/donations", {
      token: S.bankToken,
      body: { donorId: S.donorId, screeningId: deferral.data.screening.id, volumeMl: 450, collectedByName: "Nurse Sita" },
    });
    expectStatus(blocked, 422, "deferred donor cannot donate");

    const screening = await post(`/blood-bank/donors/${S.donorId}/screenings`, {
      token: S.bankToken,
      body: { decision: "eligible", screenedByName: "Dr Rao", hemoglobinGdl: 13.8, weightKg: 70, bpSystolic: 120, bpDiastolic: 80 },
    });
    expectStatus(screening, 201, "eligible screening");
    S.screeningId = screening.data.screening.id;

    const donation = await post("/blood-bank/donations", {
      token: S.bankToken,
      body: { donorId: S.donorId, screeningId: S.screeningId, volumeMl: 450, collectedByName: "Nurse Sita", bagType: "Triple" },
    });
    expectStatus(donation, 201, "donation");
    assert.match(donation.data.donation.donationCode, /^DON-\d{4}-\d{6}$/);
    S.donationId = donation.data.donation.id;

    const reused = await post("/blood-bank/donations", {
      token: S.bankToken,
      body: { donorId: S.donorId, screeningId: S.screeningId, volumeMl: 450, collectedByName: "Nurse Sita" },
    });
    expectStatus(reused, 409, "screening cannot be reused");
  });

  it("6. creates a traceable whole-blood unit in quarantine, then separates components", async () => {
    const donation = await get(`/blood-bank/donations/${S.donationId}`, { token: S.bankToken });
    const [unit] = donation.data.donation.units;
    assert.match(unit.unitCode, /^UNIT-\d{4}-\d{6}$/);
    assert.equal(unit.status, "quarantine");
    assert.equal(unit.component, "whole_blood");
    assert.equal(unit.bloodGroup, "O+");
    S.wholeUnitId = unit.id;

    const split = await post(`/blood-bank/units/${S.wholeUnitId}/separate`, {
      token: S.bankToken,
      body: { components: [{ component: "prbc", volumeMl: 280 }, { component: "plasma", volumeMl: 200 }], processedByName: "Tech Anil" },
    });
    expectStatus(split, 201, "separate");
    const prbc = split.data.units.find((u) => u.component === "prbc");
    S.prbcId = prbc.id;
    S.plasmaId = split.data.units.find((u) => u.component === "plasma").id;
    const parent = await get(`/blood-bank/units/${S.wholeUnitId}`, { token: S.bankToken });
    assert.equal(parent.data.unit.status, "processed");
  });

  it("7. records testing results; only a PASSED donation can be released", async () => {
    const early = await post(`/blood-bank/units/${S.prbcId}/release`, { token: S.bankToken, body: { releasedByName: "Dr Rao" } });
    expectStatus(early, 422, "release before testing decision");

    for (const testName of ["HIV 1&2", "HBsAg", "HCV", "Syphilis", "Malaria"]) {
      // eslint-disable-next-line no-await-in-loop
      const t = await post(`/blood-bank/donations/${S.donationId}/tests`, {
        token: S.bankToken,
        body: { testName, result: "non_reactive", performedByName: "Lab Tech Mira" },
      });
      expectStatus(t, 201, `test ${testName}`);
    }
    const unit = await get(`/blood-bank/units/${S.prbcId}`, { token: S.bankToken });
    assert.equal(unit.data.unit.status, "testing");

    const decided = await put(`/blood-bank/donations/${S.donationId}/testing`, {
      token: S.bankToken,
      body: { testingStatus: "passed", decidedByName: "Dr Rao (MO)" },
    });
    expectStatus(decided, 200, "testing decision");
    assert.equal(decided.data.donation.testingStatus, "passed");
  });

  it("8. releases the unit into AVAILABLE inventory (backend-derived counts)", async () => {
    const rel = await post(`/blood-bank/units/${S.prbcId}/release`, { token: S.bankToken, body: { releasedByName: "Dr Rao", storageLocation: "Fridge A1" } });
    expectStatus(rel, 200, "release");
    assert.equal(rel.data.unit.status, "available");
    expectStatus(await post(`/blood-bank/units/${S.plasmaId}/release`, { token: S.bankToken, body: { releasedByName: "Dr Rao" } }), 200, "release plasma");

    const inv = await get("/blood-bank/inventory", { token: S.bankToken });
    expectStatus(inv, 200, "inventory");
    const row = inv.data.rows.find((r) => r.bloodGroup === "O+" && r.component === "prbc");
    assert.equal(row.available, 1);
  });

  it("9. patient finds the blood bank nearby with real availability", async () => {
    const res = await get(`/blood/nearby?city=${encodeURIComponent(CITY)}&state=${encodeURIComponent(STATE)}&bloodGroup=O%2B&component=prbc&lat=20.30&lng=85.83`, {
      token: S.patientToken,
    });
    expectStatus(res, 200, "nearby");
    const bank = res.data.banks.find((b) => b.id === String(S.bankId));
    assert.ok(bank, "approved bank listed");
    assert.equal(bank.availableUnits, 1);
    assert.ok(bank.distanceKm !== null && bank.distanceKm < 5);
  });

  it("10. patient creates a blood request (emergency flagged) and only sees their own", async () => {
    const form = new FormData();
    const fields = {
      bloodBankId: S.bankId,
      bloodGroup: "O+",
      component: "prbc",
      unitsRequired: "1",
      urgency: "emergency",
      patientName: "Asha Patient",
      hospitalName: "City Hospital",
      contactName: "Asha's Brother",
      contactPhone: "9222222222",
      city: CITY,
      state: STATE,
    };
    Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
    form.append("document", new Blob(["%PDF-1.4 test requisition"], { type: "application/pdf" }), "requisition.pdf");
    const res = await post("/blood/requests", { token: S.patientToken, form });
    expectStatus(res, 201, "create request");
    assert.equal(res.data.request.isEmergency, true);
    assert.equal(res.data.request.documentUrl, undefined, "storage URL never leaves the server");
    assert.match(res.data.request.requestCode, /^BRQ-\d{4}-\d{6}$/);
    S.requestId = res.data.request.id;

    const other = await post("/auth/register", {
      body: { name: `Other ${RUN}`, email: `other-${RUN}@test.local`, password: "Patient123", role: "patient" },
    });
    S.otherPatientToken = other.data.tokens.accessToken;
    expectStatus(await get(`/blood/requests/${S.requestId}`, { token: S.otherPatientToken }), 404, "other patient cannot read");
    expectStatus(await get(`/blood/requests/${S.requestId}/document`, { token: S.otherPatientToken }), 403, "other patient cannot read the document");
    expectStatus(await get(`/blood/requests/${S.requestId}/document`, { token: S.patientToken }), 200, "owner streams the document");
  });

  it("11. the blood bank sees the request; another bank does not", async () => {
    const list = await get("/blood-bank/requests?emergency=true", { token: S.bankToken });
    expectStatus(list, 200, "bank list");
    assert.ok(list.data.requests.some((r) => String(r.id) === String(S.requestId)));

    const reg = await post("/auth/blood-bank/register", {
      body: {
        name: `Second Bank ${RUN}`, email: `bank2-${RUN}@test.local`, phone: "9876500009", password: "BloodBank123",
        centreType: "hospital_based", contactPerson: "Dr B", city: CITY, state: STATE,
      },
    });
    S.bank2Id = reg.data.user.id;
    S.bank2Token = reg.data.tokens.accessToken;
    await post(`/admin/blood-banks/${S.bank2Id}/verify`, { token: S.adminToken, body: { decision: "approved" } });
    expectStatus(await get(`/blood-bank/requests/${S.requestId}`, { token: S.bank2Token }), 404, "other bank cannot read");
    expectStatus(await get(`/blood-bank/units/${S.prbcId}`, { token: S.bank2Token }), 404, "other bank cannot read units");
    expectStatus(await get(`/blood-bank/donors/${S.donorId}`, { token: S.bank2Token }), 404, "other bank cannot read donors");

    const viewed = await put(`/blood-bank/requests/${S.requestId}/status`, { token: S.bankToken, body: { status: "viewed" } });
    expectStatus(viewed, 200, "viewed");
    assert.ok(viewed.data.request.reference.groups.some((g) => g.bloodGroup === "O+" && g.available === 1));
  });

  it("12. reserves a unit and prevents duplicate / concurrent reservation", async () => {
    // A second request to race for the same unit.
    const form = new FormData();
    Object.entries({
      bloodBankId: S.bankId, bloodGroup: "O+", component: "prbc", unitsRequired: "1", patientName: "Race Patient",
      hospitalName: "City Hospital", contactName: "Race", contactPhone: "9333333333",
    }).forEach(([k, v]) => form.append(k, String(v)));
    const second = await post("/blood/requests", { token: S.otherPatientToken, form });
    expectStatus(second, 201, "second request");
    S.secondRequestId = second.data.request.id;
    await put(`/blood-bank/requests/${S.secondRequestId}/status`, { token: S.bankToken, body: { status: "viewed" } });

    const [a, b] = await Promise.all([
      post(`/blood-bank/requests/${S.requestId}/reservations`, { token: S.bankToken, body: { unitId: S.prbcId, reservedByName: "Tech Anil" } }),
      post(`/blood-bank/requests/${S.secondRequestId}/reservations`, { token: S.bankToken, body: { unitId: S.prbcId, reservedByName: "Tech Anil" } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `exactly one reservation wins: ${JSON.stringify([a.body, b.body])}`);
    const winner = a.status === 200 ? S.requestId : S.secondRequestId;
    if (winner !== S.requestId) {
      // Make the main request the holder for the rest of the flow.
      const res = await get(`/blood-bank/requests/${S.secondRequestId}`, { token: S.bankToken });
      const r = res.data.request.reservations.find((x) => x.status === "active");
      await post(`/blood-bank/reservations/${r.id}/release`, { token: S.bankToken, body: { reason: "test reassignment" } });
      expectStatus(
        await post(`/blood-bank/requests/${S.requestId}/reservations`, { token: S.bankToken, body: { unitId: S.prbcId, reservedByName: "Tech Anil" } }),
        200,
        "reserve for main request"
      );
    }
    const again = await post(`/blood-bank/requests/${S.requestId}/reservations`, { token: S.bankToken, body: { unitId: S.prbcId, reservedByName: "Tech Anil" } });
    expectStatus(again, 409, "duplicate reservation");
    const unit = await BloodUnit.findByPk(S.prbcId);
    assert.equal(unit.status, "reserved");
  });

  it("13. records a cross-match; approval requires a COMPATIBLE result", async () => {
    const early = await post(`/blood-bank/requests/${S.requestId}/approve`, { token: S.bankToken, body: { approvedByName: "Dr Rao" } });
    expectStatus(early, 422, "approve before cross-match");
    const xm = await post(`/blood-bank/requests/${S.requestId}/crossmatches`, {
      token: S.bankToken,
      body: { unitId: S.prbcId, result: "compatible", method: "AHG gel card", performedByName: "Lab Tech Mira" },
    });
    expectStatus(xm, 201, "cross-match");
    assert.equal(xm.data.request.crossmatches[0].result, "compatible");
    const ok = await post(`/blood-bank/requests/${S.requestId}/approve`, { token: S.bankToken, body: { approvedByName: "Dr Rao (MO)" } });
    expectStatus(ok, 200, "approve");
    assert.equal(ok.data.request.status, "approved");
  });

  it("14–15. issues the unit transactionally and removes it from inventory", async () => {
    const res = await post(`/blood-bank/requests/${S.requestId}/issues`, {
      token: S.bankToken,
      body: { unitId: S.prbcId, issuedToName: "Ward Nurse Lata", issuedByName: "Tech Anil", verifiedByName: "Dr Rao" },
    });
    expectStatus(res, 201, "issue");
    assert.equal(res.data.request.status, "completed");
    assert.match(res.data.request.issues[0].issueCode, /^ISS-\d{4}-\d{6}$/);
    const unit = await BloodUnit.findByPk(S.prbcId);
    assert.equal(unit.status, "issued");
    const inv = await get("/blood-bank/inventory?bloodGroup=O%2B&component=prbc", { token: S.bankToken });
    const row = inv.data.rows.find((r) => r.component === "prbc");
    assert.ok(!row || (row.available === 0 && row.reserved === 0), "issued unit no longer counted");
    const twice = await post(`/blood-bank/requests/${S.requestId}/issues`, {
      token: S.bankToken,
      body: { unitId: S.prbcId, issuedToName: "X Y", issuedByName: "X Y", verifiedByName: "X Y" },
    });
    expectStatus(twice, 409, "cannot issue twice");
  });

  it("16. an expired unit cannot be reserved or issued (expiry is backend-driven)", async () => {
    // Force the plasma unit's expiry into the past, as the clock eventually would.
    await BloodUnit.update({ expiresAt: new Date(Date.now() - 60_000) }, { where: { id: S.plasmaId } });
    const form = new FormData();
    Object.entries({
      bloodBankId: S.bankId, bloodGroup: "O+", component: "plasma", unitsRequired: "1", patientName: "Plasma Patient",
      hospitalName: "City Hospital", contactName: "PP", contactPhone: "9444444444",
    }).forEach(([k, v]) => form.append(k, String(v)));
    const req = await post("/blood/requests", { token: S.patientToken, form });
    await put(`/blood-bank/requests/${req.data.request.id}/status`, { token: S.bankToken, body: { status: "viewed" } });
    const reserve = await post(`/blood-bank/requests/${req.data.request.id}/reservations`, {
      token: S.bankToken,
      body: { unitId: S.plasmaId, reservedByName: "Tech Anil" },
    });
    expectStatus(reserve, 409, "expired unit not reservable");
    const unit = await BloodUnit.findByPk(S.plasmaId);
    assert.equal(unit.status, "expired", "sweep marked it expired");
  });

  it("17. notifications were created for both sides through the existing table", async () => {
    const bankNotes = await MedicineNotification.findAll({ where: { userId: S.bankId } });
    assert.ok(bankNotes.some((n) => n.type === "blood_emergency_request"), "bank got the emergency request");
    const patientNotes = await MedicineNotification.findAll({ where: { userId: S.patientId, referenceType: "blood_request" } });
    const types = patientNotes.map((n) => n.type);
    for (const t of ["blood_request_sent", "blood_request_viewed", "blood_unit_reserved", "blood_request_approved", "blood_request_completed"]) {
      assert.ok(types.includes(t), `patient notified: ${t}`);
    }
    // And the patient reads them through the EXISTING notification API.
    const api = await get("/medicine/notifications?limit=50", { token: S.patientToken });
    expectStatus(api, 200, "existing notification endpoint");
    assert.ok(api.data.notifications.some((n) => n.referenceType === "blood_request"));
    const bankApi = await get("/medicine/notifications", { token: S.bankToken });
    expectStatus(bankApi, 200, "blood bank reads its notifications");
  });

  it("18. patient request history shows the completed request", async () => {
    const res = await get("/blood/history", { token: S.patientToken });
    expectStatus(res, 200, "history");
    const r = res.data.requests.find((x) => String(x.id) === String(S.requestId));
    assert.equal(r.status, "completed");
    const detail = await get(`/blood/requests/${S.requestId}`, { token: S.patientToken });
    assert.equal(detail.data.request.issues.length, 1);
  });

  it("19. the blood bank's request list and audit trail record every step", async () => {
    const list = await get("/blood-bank/requests?status=completed", { token: S.bankToken });
    assert.ok(list.data.requests.some((r) => String(r.id) === String(S.requestId)));
    const actions = (await BloodAuditLog.findAll({ where: { bloodBankId: S.bankId } })).map((a) => a.action);
    for (const a of [
      "donation_recorded", "unit_created", "test_result_recorded", "testing_passed", "unit_released",
      "reservation_created", "crossmatch_recorded", "request_approved", "unit_issued", "unit_expired", "request_status_changed",
    ]) {
      assert.ok(actions.includes(a), `audited: ${a}`);
    }
  });

  it("20. admin summary reflects the module", async () => {
    const res = await get("/admin/blood-banks/summary", { token: S.adminToken });
    expectStatus(res, 200, "admin summary");
    assert.ok(res.data.banks.total >= 2);
    assert.ok(res.data.banks.active >= 2);
    assert.ok(res.data.donors.total >= 1);
    assert.ok(res.data.units.issued >= 1);
    assert.ok(res.data.units.expired >= 1);
    assert.ok(res.data.requests.emergencyTotal >= 1);
    const ledger = await get(`/admin/blood-banks/requests?bloodBankId=${S.bankId}`, { token: S.adminToken });
    expectStatus(ledger, 200, "admin ledger");
    assert.ok(ledger.data.requests.some((r) => r.id === String(S.requestId) && r.issuedUnits === 1));
    expectStatus(await get("/admin/blood-banks/summary", { token: S.patientToken }), 403, "patient cannot read admin");
  });

  it("extra: patient cancel rules, camps, and a rejected bank stays locked out", async () => {
    const cancelDone = await post(`/blood/requests/${S.requestId}/cancel`, { token: S.patientToken, body: {} });
    expectStatus(cancelDone, 409, "completed request cannot be cancelled");

    const d = new Date(Date.now() + 7 * 86400000);
    const campDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const camp = await post("/blood-bank/camps", {
      token: S.bankToken,
      body: { name: "Community Drive", campDate, startTime: "09:00", endTime: "15:00", venue: "Town Hall", city: CITY, state: STATE, capacity: 1 },
    });
    expectStatus(camp, 201, "create camp");
    const reg = await post(`/blood/camps/${camp.data.camp.id}/register`, { token: S.patientToken, body: { name: "Asha", phone: "9222222222", bloodGroup: "O+" } });
    expectStatus(reg, 201, "camp register");
    const full = await post(`/blood/camps/${camp.data.camp.id}/register`, { token: S.otherPatientToken, body: { name: "Other", phone: "9555555555" } });
    expectStatus(full, 409, "camp capacity");

    const r3 = await post("/auth/blood-bank/register", {
      body: { name: `Rejected Bank ${RUN}`, email: `bank3-${RUN}@test.local`, phone: "9876500010", password: "BloodBank123", centreType: "charitable", contactPerson: "Dr C", city: CITY, state: STATE },
    });
    await post(`/admin/blood-banks/${r3.data.user.id}/verify`, { token: S.adminToken, body: { decision: "rejected", notes: "License not valid" } });
    const locked = await get("/blood-bank/donors", { token: r3.data.tokens.accessToken });
    expectStatus(locked, 403, "rejected bank locked out");
    assert.match(locked.body.error.message, /License not valid/);
    const nearby = await get(`/blood/nearby?city=${encodeURIComponent(CITY)}`, { token: S.patientToken });
    assert.ok(!nearby.data.banks.some((b) => b.id === String(r3.data.user.id)), "rejected bank not searchable");
  });
});
