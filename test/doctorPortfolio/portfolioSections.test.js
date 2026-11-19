/**
 * Doctor portfolio sections (migration 049) — end-to-end API tests.
 *
 * Real HTTP, no mocks. Covers, for every new/extended section:
 *  - the doctor's own CRUD (add → list → edit → clear a field → remove);
 *  - validation (year order, "current" with an end year, DOI, categories,
 *    future dates) and duplicate protection (expertise + procedures);
 *  - ownership: another doctor can neither edit nor delete the rows;
 *  - the public portfolio (GET /doctors/:slug) shows exactly the saved data,
 *    newest-first per section, with membership numbers hidden unless the
 *    doctor chose to show them;
 *  - gallery metadata, edit, reorder and the patient-free consent flag;
 *  - a profile with none of the new data still loads (empty arrays).
 *
 * Two ways to run (same as test/payment):
 *   1. In-process app against the LOCAL `_test` database:
 *        npm run test:db && npm test
 *   2. Against an already-running API (writes tagged test data into THAT
 *      server's database; the run's accounts are deactivated at the end):
 *        PORTFOLIO_E2E_BASE_URL=http://localhost:5055 node --test test/doctorPortfolio/portfolioSections.test.js
 */
const path = require("path");

const EXTERNAL = process.env.PORTFOLIO_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  // Only the DB connection (for fixtures/assertions) comes from .env.
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { sequelize, User, DoctorProfile } = require("../../src/models");
const { doctorSlug } = require("../../src/utils/slug");

const RUN = Date.now().toString(36);
const PASSWORD = "Portfolio#2026x";
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
const patch = (p, o) => call("PATCH", p, o);
const del = (p, o) => call("DELETE", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

/** A 1×1 PNG for gallery uploads. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const galleryForm = (fields = {}) => {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "photo.png");
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return form;
};

const email = (who) => `portfolio-${who}-${RUN}@ihs-test.example.com`;
async function register(who) {
  const res = await post("/auth/register", {
    body: { name: `Portfolio ${who} ${RUN}`, email: email(who), password: PASSWORD, role: "doctor" },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: Number(res.data.user.id), token: res.data.tokens.accessToken, name: `Portfolio ${who} ${RUN}` };
}

const S = {};
const publicProfile = async (who) => {
  const res = await get(`/doctors/${doctorSlug(S[who].name, S[who].id)}`);
  expectStatus(res, 200, `public profile ${who}`);
  return res.data;
};

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
  for (const key of ["docA", "docB"]) {
    S[key] = await register(key);
    const [profile] = await DoctorProfile.findOrCreate({
      where: { userId: S[key].id },
      defaults: { userId: S[key].id, registrationNumber: `REG-PF-${key}-${RUN}` },
    });
    // Approved + listed so the public portfolio route serves it.
    await profile.update({ verificationStatus: "approved", isListed: true, registrationNumber: `REG-PF-${key}-${RUN}` });
  }
});

after(async () => {
  // Gallery files go through the API so the stored images are deleted too.
  for (const key of ["docA", "docB"]) {
    if (!S[key]?.token) continue;
    const list = await get("/doctor/gallery", { token: S[key].token });
    for (const img of list.data || []) await del(`/doctor/gallery/${img.id}`, { token: S[key].token });
  }
  if (EXTERNAL) {
    const ids = ["docA", "docB"].map((k) => S[k]?.id).filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Existing profiles without the new data", () => {
  it("still load — owner and public — with empty new sections", async () => {
    const own = await get("/doctor/profile", { token: S.docB.token });
    expectStatus(own, 200, "own profile");
    for (const k of ["affiliations", "fellowships", "expertise"]) assert.deepEqual(own.data[k], [], `own ${k}`);
    assert.equal(own.data.shortIntro, null);
    const pub = await publicProfile("docB");
    for (const k of ["affiliations", "fellowships", "expertise", "memberships", "publications", "gallery", "awards"]) {
      assert.deepEqual(pub[k], [], `public ${k}`);
    }
    assert.equal(pub.shortIntro, "");
  });
});

describe("About section", () => {
  it("saves, reloads and publishes the short intro + career summary, and can clear them", async () => {
    const res = await patch("/doctor/profile", {
      token: S.docA.token,
      body: { shortIntro: "  Consultant cardiologist in Bhubaneswar.  ", careerSummary: "Twenty years in interventional cardiology." },
    });
    expectStatus(res, 200, "patch about");
    assert.equal(res.data.shortIntro, "Consultant cardiologist in Bhubaneswar.");
    const pub = await publicProfile("docA");
    assert.equal(pub.shortIntro, "Consultant cardiologist in Bhubaneswar.");
    assert.equal(pub.careerSummary, "Twenty years in interventional cardiology.");

    expectStatus(await patch("/doctor/profile", { token: S.docA.token, body: { careerSummary: null } }), 200, "clear");
    assert.equal((await publicProfile("docA")).careerSummary, "");
    assert.equal((await publicProfile("docA")).shortIntro, "Consultant cardiologist in Bhubaneswar.", "untouched field kept");
  });
});

describe("Current affiliations", () => {
  it("validates years and the current/end-year rule", async () => {
    const t = S.docA.token;
    expectStatus(await post("/doctor/affiliations", { token: t, body: {} }), 422, "missing org");
    expectStatus(await post("/doctor/affiliations", { token: t, body: { organization: "X", startYear: 2015, endYear: 2010 } }), 422, "end<start");
    expectStatus(await post("/doctor/affiliations", { token: t, body: { organization: "X", isCurrent: true, endYear: 2020 } }), 422, "current+end");
    expectStatus(await post("/doctor/affiliations", { token: t, body: { organization: "X", website: "javascript:alert(1)" } }), 422, "bad url");
  });

  it("adds, edits, orders current-first and removes", async () => {
    const t = S.docA.token;
    const a1 = await post("/doctor/affiliations", {
      token: t,
      body: { organization: "Old Hospital", roleTitle: "Visiting Consultant", startYear: 2008, endYear: 2012, isCurrent: false },
    });
    expectStatus(a1, 201, "add past");
    const a2 = await post("/doctor/affiliations", {
      token: t,
      body: {
        organization: "AIIMS Bhubaneswar",
        roleTitle: "Professor",
        department: "Cardiology",
        location: "Sijua, Bhubaneswar",
        startYear: 2016,
        isCurrent: true,
        website: "https://aiimsbhubaneswar.nic.in",
        phone: "+91 674 247 6789",
      },
    });
    expectStatus(a2, 201, "add current");
    assert.equal(a2.data.isCurrent, true);
    assert.equal(a2.data.department, "Cardiology");

    // Edit, then clear an optional field with null.
    const e = await patch(`/doctor/affiliations/${a2.data.id}`, { token: t, body: { roleTitle: "Professor & Head", phone: null } });
    expectStatus(e, 200, "edit");
    assert.equal(e.data.roleTitle, "Professor & Head");
    assert.equal(e.data.phone, null);
    assert.equal(e.data.website, "https://aiimsbhubaneswar.nic.in", "unsent field kept");

    // Marking the past one current clears its end year.
    const cur = await patch(`/doctor/affiliations/${a1.data.id}`, { token: t, body: { isCurrent: true } });
    expectStatus(cur, 200, "mark current");
    assert.equal(cur.data.endYear, null);
    expectStatus(await patch(`/doctor/affiliations/${a1.data.id}`, { token: t, body: { isCurrent: false, endYear: 2012 } }), 200, "revert");

    const pub = await publicProfile("docA");
    assert.deepEqual(pub.affiliations.map((a) => a.organization), ["AIIMS Bhubaneswar", "Old Hospital"], "current first");

    const own = await get("/doctor/affiliations", { token: t });
    assert.equal(own.data.length, 2, "reload shows both");

    // Another doctor can't touch them.
    expectStatus(await patch(`/doctor/affiliations/${a1.data.id}`, { token: S.docB.token, body: { organization: "Hijack" } }), 404, "foreign edit");
    expectStatus(await del(`/doctor/affiliations/${a1.data.id}`, { token: S.docB.token }), 404, "foreign delete");

    expectStatus(await del(`/doctor/affiliations/${a1.data.id}`, { token: t }), 200, "remove");
    assert.deepEqual((await publicProfile("docA")).affiliations.map((a) => a.organization), ["AIIMS Bhubaneswar"]);
  });
});

describe("Specialization & expertise", () => {
  it("adds clinical / scientific / area / interest entries and rejects duplicates", async () => {
    const t = S.docA.token;
    const entries = [
      { category: "clinical", name: "Heart failure" },
      { category: "clinical", name: "Coronary  artery disease " },
      { category: "scientific", name: "Cardiac imaging research" },
      { category: "area", name: "Preventive cardiology" },
      { category: "interest", name: "Medical education" },
    ];
    for (const body of entries) expectStatus(await post("/doctor/expertise", { token: t, body }), 201, `add ${body.name}`);
    expectStatus(await post("/doctor/expertise", { token: t, body: { category: "clinical", name: "HEART  FAILURE" } }), 409, "duplicate");
    // The same name in ANOTHER category is fine.
    expectStatus(await post("/doctor/expertise", { token: t, body: { category: "area", name: "Heart failure" } }), 201, "other category");
    expectStatus(await post("/doctor/expertise", { token: t, body: { category: "procedure", name: "PCI" } }), 422, "bad category");

    const list = await get("/doctor/expertise", { token: t });
    const cad = list.data.find((x) => x.name === "Coronary artery disease");
    assert.ok(cad, "whitespace collapsed");
    // Renaming onto an existing entry is a duplicate too; renaming elsewhere works.
    expectStatus(await patch(`/doctor/expertise/${cad.id}`, { token: t, body: { name: "heart failure" } }), 409, "rename dup");
    expectStatus(await patch(`/doctor/expertise/${cad.id}`, { token: t, body: { name: "Coronary artery disease (CAD)" } }), 200, "rename");

    const pub = await publicProfile("docA");
    assert.deepEqual(
      pub.expertise.map((x) => x.category),
      ["clinical", "clinical", "scientific", "area", "area", "interest"],
      "grouped by category"
    );
  });

  it("procedures reuse services and reject duplicates", async () => {
    const t = S.docA.token;
    expectStatus(await post("/doctor/services", { token: t, body: { name: "Angioplasty", description: "PCI with stenting" } }), 201, "add");
    expectStatus(await post("/doctor/services", { token: t, body: { name: "angioplasty" } }), 409, "dup");
    const pub = await publicProfile("docA");
    assert.equal(pub.services[0].name, "Angioplasty");
  });
});

describe("Experience + education extras", () => {
  it("stores location, clears it on edit, and validates year order", async () => {
    const t = S.docA.token;
    const x = await post("/doctor/experience", {
      token: t,
      body: { organization: "Apollo", roleTitle: "Consultant", location: "Kolkata", startYear: 2012, endYear: 2016 },
    });
    expectStatus(x, 201, "add exp");
    assert.equal(x.data.location, "Kolkata");
    const cleared = await patch(`/doctor/experience/${x.data.id}`, { token: t, body: { location: null } });
    expectStatus(cleared, 200, "clear location");
    assert.equal(cleared.data.location, null);
    assert.equal(cleared.data.isCurrent, false, "partial PATCH keeps isCurrent");

    const cur = await post("/doctor/experience", { token: t, body: { organization: "AIIMS", roleTitle: "Professor", startYear: 2016, isCurrent: true } });
    const kept = await patch(`/doctor/experience/${cur.data.id}`, { token: t, body: { description: "Heads the cath lab" } });
    assert.equal(kept.data.isCurrent, true, "a partial PATCH no longer resets isCurrent");

    expectStatus(await post("/doctor/education", { token: t, body: { degree: "MD", institution: "X", yearFrom: 2010, yearTo: 2005 } }), 422, "edu order");
    for (const [degree, yearTo] of [["MBBS", 2004], ["DM Cardiology", 2012], ["MD Medicine", 2008], ["Certificate", null]]) {
      expectStatus(await post("/doctor/education", { token: t, body: { degree, institution: "SCB Medical College", location: "Cuttack", yearTo } }), 201, degree);
    }
    const pub = await publicProfile("docA");
    assert.deepEqual(pub.education.map((e) => e.degree), ["DM Cardiology", "MD Medicine", "MBBS", "Certificate"], "newest first, undated last");
    assert.equal(pub.education[0].location, "Cuttack");
  });
});

describe("Fellowships & advanced training", () => {
  it("adds, edits and sorts by completion year (undated last, stable)", async () => {
    const t = S.docA.token;
    expectStatus(await post("/doctor/fellowships", { token: t, body: { title: "FSCAI" } }), 422, "institution required");
    expectStatus(await post("/doctor/fellowships", { token: t, body: { title: "X", institution: "Y", startYear: 2020, endYear: 2018 } }), 422, "order");
    const rows = [
      { title: "Fellowship A (ongoing)", institution: "Inst", endYear: null },
      { title: "Fellowship 2014", institution: "Inst", endYear: 2014 },
      { title: "Fellowship 2019", institution: "Inst", endYear: 2019, specialtyArea: "Interventional cardiology", location: "Singapore" },
      { title: "Fellowship B (ongoing)", institution: "Inst" },
    ];
    const ids = [];
    for (const body of rows) {
      const r = await post("/doctor/fellowships", { token: t, body });
      expectStatus(r, 201, body.title);
      ids.push(r.data.id);
    }
    const e = await patch(`/doctor/fellowships/${ids[1]}`, { token: t, body: { description: "Advanced imaging" } });
    expectStatus(e, 200, "edit");
    assert.equal(e.data.description, "Advanced imaging");
    const pub = await publicProfile("docA");
    assert.deepEqual(
      pub.fellowships.map((f) => f.title),
      ["Fellowship 2019", "Fellowship 2014", "Fellowship A (ongoing)", "Fellowship B (ongoing)"]
    );
  });
});

describe("Professional memberships", () => {
  it("keeps the membership number private unless shown, and sorts newest first", async () => {
    const t = S.docA.token;
    const m1 = await post("/doctor/memberships", {
      token: t,
      body: { organization: "Indian Medical Association", roleTitle: "Life Member", membershipNumber: "IMA-SECRET-1", sinceYear: 2005 },
    });
    expectStatus(m1, 201, "add private");
    assert.equal(m1.data.membershipNumber, "IMA-SECRET-1", "owner sees it");
    assert.equal(m1.data.showMembershipNumber, false);
    const m2 = await post("/doctor/memberships", {
      token: t,
      body: { organization: "Cardiological Society of India", membershipNumber: "CSI-42", showMembershipNumber: true, sinceYear: 2014, validUntilYear: 2030 },
    });
    expectStatus(m2, 201, "add public");
    expectStatus(await post("/doctor/memberships", { token: t, body: { organization: "X", sinceYear: 2015, validUntilYear: 2010 } }), 422, "expiry<since");

    let pub = await publicProfile("docA");
    assert.deepEqual(pub.memberships.map((m) => m.organization), ["Cardiological Society of India", "Indian Medical Association"]);
    assert.equal(pub.memberships[0].membershipNumber, "CSI-42");
    assert.equal(pub.memberships[1].membershipNumber, null, "private number hidden");
    assert.ok(!("showMembershipNumber" in pub.memberships[0]), "flag not public");
    assert.ok(!JSON.stringify(pub).includes("IMA-SECRET-1"), "never leaks anywhere in the payload");

    expectStatus(await patch(`/doctor/memberships/${m1.data.id}`, { token: t, body: { showMembershipNumber: true } }), 200, "show");
    pub = await publicProfile("docA");
    assert.equal(pub.memberships[1].membershipNumber, "IMA-SECRET-1");
  });
});

describe("Research & publications", () => {
  it("stores authors/DOI/abstract/category, validates the DOI, sorts by year", async () => {
    const t = S.docA.token;
    expectStatus(await post("/doctor/publications", { token: t, body: { title: "X", doi: "not-a-doi" } }), 422, "bad doi");
    const p1 = await post("/doctor/publications", {
      token: t,
      body: { title: "Older paper", publisher: "IHJ", year: 2015, authors: "A. Rao, B. Das", doi: "10.1016/j.ihj.2015.01.001", category: "Original research" },
    });
    expectStatus(p1, 201, "add");
    assert.equal(p1.data.doi, "10.1016/j.ihj.2015.01.001");
    expectStatus(await post("/doctor/publications", { token: t, body: { title: "Newer paper", year: 2022, abstract: "Short summary." } }), 201, "add 2");
    expectStatus(await post("/doctor/publications", { token: t, body: { title: "Undated paper" } }), 201, "add 3");
    const cleared = await patch(`/doctor/publications/${p1.data.id}`, { token: t, body: { doi: null } });
    assert.equal(cleared.data.doi, null, "cleared");
    const pub = await publicProfile("docA");
    assert.deepEqual(pub.publications.map((p) => p.title), ["Newer paper", "Older paper", "Undated paper"]);
    assert.equal(pub.publications[1].authors, "A. Rao, B. Das");
  });
});

describe("Awards ordering", () => {
  it("shows awards newest first with undated ones last", async () => {
    const t = S.docA.token;
    for (const [title, awardYear] of [["Award 2010", 2010], ["Award undated", null], ["Award 2021", 2021]]) {
      expectStatus(await post("/doctor/awards", { token: t, body: { title, awardYear } }), 201, title);
    }
    const pub = await publicProfile("docA");
    assert.deepEqual(pub.awards.map((a) => a.title), ["Award 2021", "Award 2010", "Award undated"]);
  });
});

describe("Clinical gallery", () => {
  it("uploads with metadata, edits it, reorders, and keeps uploads optional-metadata", async () => {
    const t = S.docA.token;
    const g1 = await post("/doctor/gallery", {
      token: t,
      form: galleryForm({ title: "Reception", caption: "Front desk", category: "clinic", altText: "Clinic reception desk", takenOn: "2024-05-01", consent: true }),
    });
    expectStatus(g1, 201, "upload with meta");
    assert.equal(g1.data.category, "clinic");
    assert.equal(g1.data.takenOn, "2024-05-01");
    // Older clients (the mobile app) send only a caption.
    const g2 = await post("/doctor/gallery", { token: t, form: galleryForm({ caption: "Cath lab" }) });
    expectStatus(g2, 201, "legacy upload");
    expectStatus(await post("/doctor/gallery", { token: t, form: galleryForm({ category: "patients" }) }), 422, "bad category");
    expectStatus(await post("/doctor/gallery", { token: t, form: galleryForm({ takenOn: "2999-01-01" }) }), 422, "future date");

    const e = await patch(`/doctor/gallery/${g2.data.id}`, { token: t, body: { title: "Cath lab", category: "equipment", caption: "" } });
    expectStatus(e, 200, "edit meta");
    assert.equal(e.data.category, "equipment");
    assert.equal(e.data.caption, null, "blank clears");
    expectStatus(await patch(`/doctor/gallery/${g2.data.id}`, { token: S.docB.token, body: { title: "x" } }), 404, "foreign edit");

    expectStatus(await put("/doctor/gallery/order", { token: t, body: { ids: [g2.data.id] } }), 422, "partial order");
    expectStatus(await put("/doctor/gallery/order", { token: S.docB.token, body: { ids: [g2.data.id, g1.data.id] } }), 422, "foreign order");
    const r = await put("/doctor/gallery/order", { token: t, body: { ids: [g2.data.id, g1.data.id] } });
    expectStatus(r, 200, "reorder");
    const pub = await publicProfile("docA");
    assert.deepEqual(pub.gallery.map((g) => g.id), [g2.data.id, g1.data.id]);
    assert.equal(pub.gallery[1].altText, "Clinic reception desk");
  });
});

describe("Doctor preview", () => {
  it("returns the same public shape at any status", async () => {
    const res = await get("/doctor/preview", { token: S.docA.token });
    expectStatus(res, 200, "preview");
    assert.ok(Array.isArray(res.data.affiliations) && res.data.affiliations.length === 1);
    assert.ok(res.data.expertise.length >= 5);
  });
});
