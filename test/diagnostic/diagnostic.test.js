/**
 * Diagnostic Lab flow (migration 038) — end-to-end API tests.
 *
 * Real HTTP, no mocks. One request's whole life, as the IHS Diagnostic Lab and
 * IHS Patient mobile apps drive it: catalogue → patient share → lab answer →
 * patient booking → lab status transitions → report upload → patient download,
 * plus the isolation rules (lab ↔ lab, lab ↔ pharmacy, patient ↔ lab routes).
 *
 * Two ways to run (same harness as test/pharmacy):
 *   1. The project way (in-process app, LOCAL `_test` database):
 *        npm run test:db && npm test
 *   2. Against an already-running API (writes test data into THAT server's
 *      database; accounts are tagged @ihs-test.example.com and deactivated at the end):
 *        DIAGNOSTIC_E2E_BASE_URL=http://localhost:5055 node --test test/diagnostic/diagnostic.test.js
 */
const path = require("path");

const EXTERNAL = process.env.DIAGNOSTIC_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  // Only the DB connection (for the cleanup) comes from .env.
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { sequelize, User } = require("../../src/models");

const RUN = Date.now().toString(36).toUpperCase();
const DAY_MS = 86400000;
const istDay = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * DAY_MS).toISOString().slice(0, 10);

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
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) {
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type };
  }
  const json = await res.json();
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

/** A 1×1 PNG (the prescription) and a minimal PDF (the report). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const fileForm = (field, buffer, name, type, extra = {}) => {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), name);
  for (const [k, v] of Object.entries(extra)) {
    for (const item of Array.isArray(v) ? v : [v]) form.append(k, String(item));
  }
  return form;
};

const S = {};
// example.com is reserved for documentation — nothing is ever delivered there.
const email = (who) => `diag-${who}-${RUN.toLowerCase()}@ihs-test.example.com`;
const PASSWORD = "Diag12345";

async function register(who, role) {
  const res = await post("/auth/register", {
    body: { name: `${who} ${RUN}`, email: email(who), password: PASSWORD, role, phone: "9876543210", city: `Labpur${RUN}`, state: "Odisha" },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: res.data.user.id, token: res.data.tokens.accessToken };
}

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) {
    base = EXTERNAL.replace(/\/+$/, "");
  } else {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
});

after(async () => {
  if (EXTERNAL) {
    // Keep the shared database clean: the run's accounts vanish from every search.
    const ids = [S.labA?.id, S.labB?.id, S.patient?.id, S.store?.id].filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Diagnostic lab", () => {
  it("1. accounts + lab login through the provider portal", async () => {
    S.labA = await register("lab-a", "diagnostic_lab");
    S.labB = await register("lab-b", "diagnostic_lab");
    S.patient = await register("patient", "patient");
    S.store = await register("store", "medicine_store");

    const login = await post("/auth/medicine/login", { body: { email: email("lab-a"), password: PASSWORD } });
    expectStatus(login, 200, "lab login");
    assert.equal(login.data.user.role, "diagnostic_lab");
    S.labA.token = login.data.tokens.accessToken;

    // The patient portal must not accept a lab account.
    const wrong = await post("/auth/login", { body: { email: email("lab-a"), password: PASSWORD, audience: "patient" } });
    assert.ok([401, 403].includes(wrong.status), `lab on patient portal: got ${wrong.status}`);
  });

  it("2. a new lab's summary is real (empty) data", async () => {
    const res = await get("/diagnostics/summary", { token: S.labA.token });
    expectStatus(res, 200, "summary");
    assert.ok(res.data && typeof res.data === "object");
  });

  it("3. role isolation between labs, pharmacies and patients", async () => {
    expectStatus(await get("/diagnostics/tests", { token: S.store.token }), 403, "pharmacy → lab catalogue");
    expectStatus(await get("/medicine/pharmacy/dashboard", { token: S.labA.token }), 403, "lab → pharmacy dashboard");
    expectStatus(await get("/diagnostics/requests/incoming", { token: S.patient.token }), 403, "patient → lab inbox");
    expectStatus(await get("/diagnostics/requests/mine", { token: S.labA.token }), 403, "lab → patient requests");
  });

  it("4. catalogue: create, duplicate refused, other lab cannot edit", async () => {
    const created = await post("/diagnostics/tests", {
      token: S.labA.token,
      body: { name: `CBC ${RUN}`, description: "Complete blood count", price: 350 },
    });
    expectStatus(created, 201, "create test");
    S.testId = created.data.test.id;

    const dup = await post("/diagnostics/tests", { token: S.labA.token, body: { name: `CBC ${RUN}`, price: 400 } });
    expectStatus(dup, 409, "duplicate test name");

    const foreign = await put(`/diagnostics/tests/${S.testId}`, { token: S.labB.token, body: { price: 1 } });
    assert.ok([403, 404].includes(foreign.status), `lab B edits lab A test: got ${foreign.status}`);

    const list = await get("/diagnostics/tests", { token: S.labA.token });
    expectStatus(list, 200, "list tests");
    assert.ok(list.data.tests.some((t) => String(t.id) === String(S.testId)));
    const listB = await get("/diagnostics/tests", { token: S.labB.token });
    assert.ok(!listB.data.tests.some((t) => String(t.id) === String(S.testId)), "lab B must not see lab A's catalogue");
  });

  it("5. patient shares a prescription with lab A only", async () => {
    const form = fileForm("prescription", PNG, "rx.png", "image/png", { labIds: [S.labA.id], notes: "Fasting sample" });
    const res = await post("/diagnostics/requests", { token: S.patient.token, form });
    expectStatus(res, 201, "share");
    assert.equal(res.data.requests.length, 1);
    S.requestId = res.data.requests[0].id;
  });

  it("6. lab A sees it; lab B cannot read the request or its file", async () => {
    const inbox = await get("/diagnostics/requests/incoming", { token: S.labA.token });
    expectStatus(inbox, 200, "lab A inbox");
    const rows = inbox.data.requests || inbox.data.items || inbox.data.rows || [];
    assert.ok(rows.some((r) => String(r.id) === String(S.requestId)), "request in lab A inbox");

    const file = await get(`/diagnostics/requests/${S.requestId}/file`, { token: S.labA.token });
    expectStatus(file, 200, "lab A streams prescription");
    assert.ok(file.buffer.length > 0);

    expectStatus(await get(`/diagnostics/requests/${S.requestId}`, { token: S.labB.token }), 403, "lab B reads request");
    expectStatus(await get(`/diagnostics/requests/${S.requestId}/file`, { token: S.labB.token }), 403, "lab B streams file");
  });

  it("7. only allowed status transitions are accepted", async () => {
    const skip = await put(`/diagnostics/requests/${S.requestId}/status`, { token: S.labA.token, body: { status: "confirmed" } });
    expectStatus(skip, 400, "pending → confirmed");
    const viewed = await put(`/diagnostics/requests/${S.requestId}/status`, { token: S.labA.token, body: { status: "viewed" } });
    expectStatus(viewed, 200, "pending → viewed");
    assert.equal(viewed.data.request.status, "viewed");
  });

  it("8. lab answers with availability + price", async () => {
    const res = await put(`/diagnostics/requests/${S.requestId}/response`, {
      token: S.labA.token,
      body: {
        tests: [
          { status: "available", diagnosticTestId: S.testId },
          { status: "unavailable", testName: "MRI Brain", reason: "No MRI machine" },
        ],
        note: "Sample collection 8-10 AM",
      },
    });
    expectStatus(res, 200, "respond");
    assert.equal(res.data.request.status, "available");
    const tests = res.data.request.tests || [];
    const available = tests.find((t) => t.status === "available");
    assert.ok(available, "an available test on the request");
    assert.equal(Number(available.price), 350, "price defaults to the catalogue price");
    S.requestTestId = available.id;
  });

  it("9. patient books: past date refused, valid date accepted", async () => {
    const past = await post(`/diagnostics/requests/${S.requestId}/book`, {
      token: S.patient.token,
      body: { testIds: [S.requestTestId], preferredDate: istDay(-2) },
    });
    expectStatus(past, 400, "book in the past");
    const res = await post(`/diagnostics/requests/${S.requestId}/book`, {
      token: S.patient.token,
      body: { testIds: [S.requestTestId], preferredDate: istDay(1) },
    });
    expectStatus(res, 200, "book");
    assert.equal(res.data.request.status, "booking_requested");
  });

  it("10. report upload needs a completed test; then it becomes report_ready", async () => {
    const early = await post(`/diagnostics/requests/${S.requestId}/reports`, {
      token: S.labA.token,
      form: fileForm("report", PDF, "report.pdf", "application/pdf", { testIds: [S.requestTestId] }),
    });
    expectStatus(early, 400, "report before completion");

    for (const status of ["confirmed", "test_completed"]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await put(`/diagnostics/requests/${S.requestId}/status`, { token: S.labA.token, body: { status } });
      expectStatus(r, 200, `→ ${status}`);
    }

    const foreign = await post(`/diagnostics/requests/${S.requestId}/reports`, {
      token: S.labB.token,
      form: fileForm("report", PDF, "report.pdf", "application/pdf", { testIds: [S.requestTestId] }),
    });
    assert.ok([403, 404].includes(foreign.status), `lab B uploads: got ${foreign.status}`);

    const res = await post(`/diagnostics/requests/${S.requestId}/reports`, {
      token: S.labA.token,
      form: fileForm("report", PDF, "report.pdf", "application/pdf", { testIds: [S.requestTestId] }),
    });
    expectStatus(res, 201, "upload report");
    assert.equal(res.data.request.status, "report_ready");
  });

  it("11. the patient (and only the parties) can download the report", async () => {
    const mine = await get(`/diagnostics/requests/${S.requestId}/tests/${S.requestTestId}/report`, { token: S.patient.token });
    expectStatus(mine, 200, "patient downloads report");
    assert.ok(mine.buffer.subarray(0, 4).toString() === "%PDF", "PDF bytes");

    const other = await get(`/diagnostics/requests/${S.requestId}/tests/${S.requestTestId}/report`, { token: S.labB.token });
    expectStatus(other, 403, "lab B downloads report");

    const list = await get("/diagnostics/requests/mine", { token: S.patient.token });
    expectStatus(list, 200, "patient requests");
  });
});
