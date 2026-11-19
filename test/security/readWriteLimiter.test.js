/**
 * Signed-in reads have their own per-user budget; writes and anonymous traffic
 * keep the tight backstop. DB-free (every request is a 404 before any query).
 *
 *   node --test test/security/readWriteLimiter.test.js
 */
require("../testEnv");
process.env.RATE_LIMIT_MAX = "3"; // anonymous + writes
process.env.READ_RATE_LIMIT_MAX = "6"; // signed-in reads
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const env = require("../../src/config/env");
const app = require("../../src/app");

let base;
let server;
test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

const tokenFor = (id) => jwt.sign({ sub: String(id), role: "doctor", email: `d${id}@x.test` }, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
const get = (p, token) => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (p, token) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: "{}" });

test("a signed-in user's reads get the READ budget, not the tight one", async () => {
  const t = tokenFor(1001);
  for (let i = 0; i < 6; i += 1) assert.notEqual((await get(`/nope-${i}`, t)).status, 429, `read ${i + 1} of 6`);
  assert.equal((await get("/nope-x", t)).status, 429, "7th read exceeds the read budget");
});

test("one user's reads never spend another user's budget", async () => {
  const a = tokenFor(2001);
  const b = tokenFor(2002);
  for (let i = 0; i < 7; i += 1) await get(`/nope-${i}`, a);
  assert.notEqual((await get("/nope-b", b)).status, 429, "user B is unaffected by user A");
});

test("exhausting reads does not block that user's writes (separate buckets)", async () => {
  const t = tokenFor(3001);
  for (let i = 0; i < 7; i += 1) await get(`/nope-${i}`, t);
  assert.notEqual((await post("/nope-write", t)).status, 429, "write bucket is untouched by reads");
});

test("writes keep the tight cap", async () => {
  const t = tokenFor(4001);
  for (let i = 0; i < 3; i += 1) assert.notEqual((await post(`/nope-${i}`, t)).status, 429);
  assert.equal((await post("/nope-x", t)).status, 429, "4th write exceeds RATE_LIMIT_MAX");
});

test("a forged token earns no fresh bucket: it falls back to the shared IP cap", async () => {
  const fake = jwt.sign({ sub: "9", role: "doctor" }, "not-the-real-secret");
  let limited = false;
  for (let i = 0; i < 10 && !limited; i += 1) limited = (await get(`/nope-${i}`, fake)).status === 429;
  assert.ok(limited, "forged-token requests are capped by the anonymous/IP limit");
});
