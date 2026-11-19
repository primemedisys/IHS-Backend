/**
 * The blanket per-IP limiter must not lock users out of signing in.
 *
 * Ordinary API traffic (page loads, polling) spends the global bucket; the
 * credential endpoints have their own limiters and must keep answering when it
 * is empty. Everything else must still be capped. DB-free: every request here
 * is a 404 or fails validation before any query runs.
 *
 *   node --test test/security/globalLimiterAuthRoutes.test.js
 */
require("../testEnv");
// A tiny global budget for this file only (testEnv sets a huge one for the suite).
process.env.RATE_LIMIT_MAX = "3";
process.env.AUTH_RATE_LIMIT_MAX = "2";
const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../../src/app");

let base;
let server;
test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("global bucket empty → other routes 429, sign-in routes still reach their own limiter", async () => {
  for (let i = 0; i < 3; i += 1) assert.notEqual((await fetch(`${base}/no-such-route-${i}`)).status, 429, "within budget");
  assert.equal((await fetch(`${base}/no-such-route-x`)).status, 429, "global cap still applies");
  assert.equal((await fetch(`${base}/auth/me`)).status, 429, "/auth/me (GET) is not exempt");

  // Validation failures (no DB): answered by the route, not refused by the global cap.
  const refresh = await post("/auth/refresh", {});
  assert.notEqual(refresh.status, 429, `refresh got ${refresh.status}`);
  const login1 = await post("/auth/login", { email: "nobody@ihs-test.example.com" });
  assert.notEqual(login1.status, 429, `login got ${login1.status}`);
});

test("brute-force guard unchanged: failed sign-ins for one account still hit 429", async () => {
  const body = { email: "guess@ihs-test.example.com" }; // invalid (no password) → counted as a failure
  await post("/auth/login", body);
  await post("/auth/login", body);
  assert.equal((await post("/auth/login", body)).status, 429, "authLimiter (failed attempts) still refuses");
});
