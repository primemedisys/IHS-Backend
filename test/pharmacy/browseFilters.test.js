/**
 * Server-side marketplace filters the patient mobile app relies on — end-to-end
 * against the LOCAL test database (prepare it with `npm run test:db`).
 *
 *  - GET /medicine/browse      providerId + minDiscount
 *  - GET /medicine/providers   lat/lng → distanceKm, nearest first, radiusKm
 *  - GET /medicine/provider/:id exposes the location the store map needs
 *  - defaults are unchanged; malformed combinations are 422
 *
 * Every account and medicine carries this run's tag and a run-unique city, so
 * the assertions only ever see this run's rows on a reused database.
 *
 * Two ways to run (same as pharmacy.test.js):
 *   1. In-process app on the LOCAL `_test` database:
 *        npm run test:db && node --test test/pharmacy/browseFilters.test.js
 *   2. Against an already-running API (writes into THAT server's database;
 *      accounts are tagged @ihs-test.example.com and deactivated at the end):
 *        PHARMACY_E2E_BASE_URL=http://localhost:5055 node --test test/pharmacy/browseFilters.test.js
 */
const path = require("path");

const EXTERNAL = process.env.PHARMACY_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  // Only the DB connection (for setup/cleanup) comes from .env.
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Op } = require("sequelize");

const { sequelize, User, MedicineMaster } = require("../../src/models");

const RUN = Date.now().toString(36).toUpperCase();
const CITY = `Mappur${RUN}`;
const PASSWORD = "Pharma1234";
let server;
let base;

async function call(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${urlPath}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

const qs = (params) => new URLSearchParams(params).toString();
const email = (who) => `browse-${who}-${RUN.toLowerCase()}@ihs-test.example.com`;

/** Reference haversine, for checking the SQL one. */
function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Real places in Odisha: Cuttack ≈ 19 km and Puri ≈ 54 km from Bhubaneswar.
const BBSR = { lat: 20.2961, lng: 85.8245 };
const CUTTACK = { lat: 20.4625, lng: 85.883 };
const PURI = { lat: 19.8135, lng: 85.8312 };

const S = {};

async function registerStore(who, coords) {
  const res = await post("/auth/register", {
    body: {
      name: `${who} ${RUN}`,
      email: email(who),
      password: PASSWORD,
      role: "medicine_store",
      phone: "9876543210",
      addressLine: `${who} Road`,
      city: CITY,
      state: "Odisha",
      pincode: "751001",
      ...(coords || {}),
    },
  });
  expectStatus(res, 201, `register ${who}`);
  const login = await post("/auth/medicine/login", { body: { email: email(who), password: PASSWORD } });
  expectStatus(login, 200, `login ${who}`);
  return { id: res.data.user.id, token: login.data.tokens.accessToken };
}

async function addMedicine(store, name, fields) {
  const res = await post("/medicine/my-medicines", {
    token: store.token,
    body: { medicineName: `${name} ${RUN}`, medicineType: "tablet", stock: 10, ...fields },
  });
  expectStatus(res, 201, `add ${name}`);
  return res.data.medicine.id;
}

const browse = (params) => get(`/medicine/browse?${qs({ search: RUN, limit: 50, ...params })}`);
const providers = (params) => get(`/medicine/providers?${qs({ city: CITY, limit: 50, ...params })}`);
const ids = (list) => list.map((x) => Number(x.id)).sort((a, b) => a - b);

describe("medicine marketplace filters", () => {
  before(async () => {
    await sequelize.authenticate();
    if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
    else {
      // eslint-disable-next-line global-require
      const app = require("../../src/app");
      server = app.listen(0);
      await new Promise((r) => server.once("listening", r));
      base = `http://127.0.0.1:${server.address().port}`;
    }

    // Names are chosen so the default name order differs from distance order.
    S.near = await registerStore("zulu-bbsr", BBSR);
    S.mid = await registerStore("alpha-cuttack", CUTTACK);
    S.far = await registerStore("mike-puri", PURI);
    S.none = await registerStore("bravo-nocoords");
    S.gone = await registerStore("charlie-inactive", BBSR);

    S.alpha = await addMedicine(S.near, "Alphacet", { price: 100, discountPercent: 20 });
    // A big saving against MRP but NO item discount: discountPercent is 0.
    S.beta = await addMedicine(S.near, "Betamol", { price: 50, mrp: 80 });
    S.gamma = await addMedicine(S.mid, "Gammazol", { price: 100, mrp: 100, discountPercent: 10 });
    S.delta = await addMedicine(S.mid, "Deltacin", { price: 40, discountPercent: 25 });
    S.goneItem = await addMedicine(S.gone, "Gonemed", { price: 10, discountPercent: 50 });
    await User.update({ isActive: false }, { where: { id: S.gone.id } });
  });

  after(async () => {
    if (EXTERNAL) {
      // Keep a shared database clean: this run's stores and medicines vanish
      // from every patient / pharmacy search.
      const accounts = [S.near, S.mid, S.far, S.none, S.gone].filter(Boolean).map((a) => a.id);
      if (accounts.length) await User.update({ isActive: false }, { where: { id: accounts } });
      await MedicineMaster.update({ isActive: false }, { where: { medicineName: { [Op.like]: `%${RUN}%` } } });
    }
    if (server) await new Promise((r) => server.close(r));
    await sequelize.close();
  });

  it("browse without the new params is unchanged", async () => {
    const res = await browse({});
    expectStatus(res, 200, "browse");
    assert.deepEqual(ids(res.data.medicines), [S.alpha, S.beta, S.gamma, S.delta].map(Number).sort((a, b) => a - b));
    assert.equal(res.data.total, 4, "inactive provider's listing excluded");
    for (const key of ["medicines", "total", "page", "limit", "totalPages"]) assert.ok(key in res.data, key);
    const alpha = res.data.medicines.find((m) => Number(m.id) === Number(S.alpha));
    assert.equal(alpha.discountPercent, 20);
    assert.equal(alpha.effectivePrice, 80);
  });

  it("browse ?providerId returns only that store's active listings", async () => {
    const res = await browse({ providerId: S.near.id });
    expectStatus(res, 200, "providerId");
    assert.deepEqual(ids(res.data.medicines), [S.alpha, S.beta].map(Number).sort((a, b) => a - b));
    assert.ok(res.data.medicines.every((m) => Number(m.providerId) === Number(S.near.id)));
    assert.equal(res.data.total, 2);

    const inactive = await browse({ providerId: S.gone.id });
    expectStatus(inactive, 200, "inactive provider");
    assert.equal(inactive.data.total, 0, "an inactive store's shelf stays hidden");
  });

  it("browse ?minDiscount keeps only listings showing at least that discountPercent", async () => {
    const res = await browse({ minDiscount: 20 });
    expectStatus(res, 200, "minDiscount");
    assert.deepEqual(ids(res.data.medicines), [S.alpha, S.delta].map(Number).sort((a, b) => a - b));
    assert.ok(res.data.medicines.every((m) => m.discountPercent >= 20), "no row shows less than asked");
    assert.equal(res.data.total, 2);

    const exact = await browse({ minDiscount: 25 });
    assert.deepEqual(ids(exact.data.medicines), [Number(S.delta)], "boundary is inclusive");

    const combined = await browse({ minDiscount: 10, providerId: S.mid.id });
    assert.deepEqual(ids(combined.data.medicines), [S.gamma, S.delta].map(Number).sort((a, b) => a - b));

    const none = await browse({ minDiscount: 0 });
    assert.equal(none.data.total, 4, "0 filters nothing");
  });

  it("browse rejects malformed new params", async () => {
    expectStatus(await browse({ minDiscount: 150 }), 422, "minDiscount > 100");
    expectStatus(await browse({ providerId: "abc" }), 422, "non-numeric providerId");
  });

  it("providers without lat/lng: same order and no distanceKm", async () => {
    const res = await providers({});
    expectStatus(res, 200, "providers");
    const names = res.data.providers.map((p) => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "name order");
    assert.equal(res.data.total, 4);
    assert.ok(res.data.providers.every((p) => !("distanceKm" in p)));
  });

  it("providers with lat/lng: distanceKm, nearest first, no coordinates last", async () => {
    const res = await providers(BBSR);
    expectStatus(res, 200, "near");
    const list = res.data.providers;
    assert.deepEqual(list.map((p) => Number(p.id)), [S.near.id, S.mid.id, S.far.id, S.none.id].map(Number));
    assert.equal(res.data.total, 4, "no radius → nobody excluded");
    assert.equal(list[0].distanceKm, 0);
    assert.equal(list[1].distanceKm, Math.round(haversineKm(BBSR, CUTTACK) * 10) / 10);
    assert.equal(list[2].distanceKm, Math.round(haversineKm(BBSR, PURI) * 10) / 10);
    assert.ok(list[1].distanceKm > 15 && list[1].distanceKm < 25, `Cuttack ≈ 19 km, got ${list[1].distanceKm}`);
    assert.equal(list[3].distanceKm, null);
    assert.equal(list[0].medicineCount, 2, "existing fields still present");
  });

  it("providers ?radiusKm excludes far and coordinate-less stores, paginating correctly", async () => {
    const res = await providers({ ...BBSR, radiusKm: 25 });
    expectStatus(res, 200, "radius");
    assert.deepEqual(res.data.providers.map((p) => Number(p.id)), [S.near.id, S.mid.id].map(Number));
    assert.equal(res.data.total, 2);

    const page2 = await providers({ ...BBSR, radiusKm: 25, limit: 1, page: 2 });
    expectStatus(page2, 200, "radius page 2");
    assert.equal(page2.data.total, 2);
    assert.equal(page2.data.totalPages, 2);
    assert.deepEqual(page2.data.providers.map((p) => Number(p.id)), [Number(S.mid.id)]);
  });

  it("providers rejects lat without lng, and radiusKm without a position", async () => {
    expectStatus(await providers({ lat: BBSR.lat }), 422, "lat only");
    expectStatus(await providers({ lng: BBSR.lng }), 422, "lng only");
    expectStatus(await providers({ radiusKm: 10 }), 422, "radius without lat/lng");
    expectStatus(await providers({ ...BBSR, radiusKm: 500 }), 422, "radius > 200");
    expectStatus(await providers({ lat: 91, lng: 0 }), 422, "lat out of range");
  });

  it("provider profile carries the store's map location", async () => {
    const res = await get(`/medicine/provider/${S.mid.id}`);
    expectStatus(res, 200, "profile");
    const p = res.data.profile;
    assert.equal(Number(p.lat), CUTTACK.lat);
    assert.equal(Number(p.lng), CUTTACK.lng);
    assert.equal(p.addressLine, `alpha-cuttack Road`);
    assert.equal(p.pincode, "751001");
  });
});
