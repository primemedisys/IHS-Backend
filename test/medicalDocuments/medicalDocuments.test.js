/**
 * Medical Documents (migration 058) — the patient website's document library
 * on uploaded_records: categorised uploads, identity documents (Aadhaar …)
 * kept away from every other reader, last-4-digit masking, ownership on every
 * route, file validation, replace and delete rules.
 *
 *   In-process (needs .env.test):   node --test test/medicalDocuments
 *   Against a running API:          MEDICAL_DOCS_E2E_BASE_URL=http://127.0.0.1:5070 node --test test/medicalDocuments
 *
 * External mode uses backend/.env (the same DB as that API). Accounts are
 * tagged @ihs-test.example.com; their documents and files are removed and the
 * accounts deactivated afterwards.
 */
const path = require("path");

const EXTERNAL = process.env.MEDICAL_DOCS_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { sequelize, User, UploadedRecord } = require("../../src/models");
const env = require("../../src/config/env");
const patientService = require("../../src/services/patient.service");
const clinicalAccess = require("../../src/services/clinicalAccess.service");
const uploadService = require("../../src/services/upload.service");
const { CLINICAL_ACCESS_CATEGORIES } = require("../../src/config/constants");

const RUN = Date.now().toString(36);
const PASSWORD = "MedDocs#2026x";
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

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
}

// Real (tiny) files — the server checks the bytes, not just the name.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

function docForm(bytes, name, type, fields = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const email = (who) => `meddocs-${who}-${RUN}@ihs-test.example.com`;
async function register(who, role) {
  const res = await call("POST", "/auth/register", {
    body: { name: `${who} Tester${RUN}`, email: email(who), password: PASSWORD, role },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: Number(res.data.user.id), token: res.data.tokens.accessToken };
}

const upload = (who, bytes, name, type, fields) =>
  call("POST", "/patient/records/upload", { token: S[who].token, form: docForm(bytes, name, type, fields) });

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
  S.patA = await register("patA", "patient");
  S.patB = await register("patB", "patient");
  S.doc = await register("doc", "doctor");
});

after(async () => {
  const patients = [S.patA?.id, S.patB?.id].filter(Boolean);
  if (patients.length) {
    const rows = await UploadedRecord.findAll({ where: { patientId: patients } });
    for (const r of rows) {
      const key = uploadService.keyFromUrl(r.fileUrl);
      if (key && key.startsWith("patient/")) await uploadService.remove(key).catch(() => {});
      await r.destroy();
    }
  }
  const ids = [S.patA?.id, S.patB?.id, S.doc?.id].filter(Boolean);
  if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Categorised uploads", () => {
  it("files an Aadhaar card as an identity document, keeping only the last 4 digits", async () => {
    const res = await upload("patA", PNG, "aadhaar.png", "image/png", {
      documentKind: "aadhaar",
      tag: "My Aadhaar card",
      idLast4: "1234",
    });
    expectStatus(res, 201, "aadhaar upload");
    const d = res.data;
    assert.equal(d.fileType, "identity");
    assert.equal(d.documentKind, "aadhaar");
    assert.equal(d.idLast4, "1234");
    assert.equal(d.source, "patient");
    assert.equal(d.originalName, "aadhaar.png");
    assert.equal(d.mimeType, "image/png");
    assert.equal(d.fileSize, PNG.length);
    // Never a public storage URL: a signed, expiring /api/files link.
    assert.match(d.fileUrl, /\/api\/files\/[^/]+\.[^/]+\//);
    S.aadhaar = d;
  });

  it("refuses a full Aadhaar number anywhere in an identity document's text", async () => {
    const typed = await upload("patA", PNG, "a.png", "image/png", { documentKind: "aadhaar", tag: "Aadhaar 2345 6789 0123" });
    expectStatus(typed, 422, "full number in title");
    const longLast4 = await upload("patA", PNG, "a.png", "image/png", { documentKind: "aadhaar", tag: "Aadhaar", idLast4: "234567890123" });
    expectStatus(longLast4, 422, "12 digits as last-4");
    const letters = await upload("patA", PNG, "a.png", "image/png", { documentKind: "aadhaar", tag: "Aadhaar", idLast4: "12ab" });
    expectStatus(letters, 422, "non-digit last-4");
  });

  it("derives the stored file type from the document kind (the client cannot choose it)", async () => {
    const cases = [
      ["prescription", "prescription", "Outside prescription"],
      ["xray", "xray", "Chest X-ray"],
      ["blood_test", "lab_report", "CBC"],
      ["ct_scan", "other", "CT head"],
      ["discharge_summary", "other", "Discharge summary"],
    ];
    for (const [kind, fileType, tag] of cases) {
      // fileType "identity" is sent on purpose — the kind must win.
      const res = await upload("patA", PDF, `${kind}.pdf`, "application/pdf", {
        documentKind: kind,
        fileType: "identity",
        tag,
        recordDate: "2026-10-01",
        location: "City Diagnostics",
        doctorName: "Dr. Outside",
      });
      expectStatus(res, 201, `upload ${kind}`);
      assert.equal(res.data.fileType, fileType, kind);
      assert.equal(res.data.documentKind, kind);
      assert.equal(res.data.idLast4, null, "last-4 digits only belong to identity documents");
      S[kind] = res.data;
    }
  });

  it("lists every document for its owner, and none of them for anyone else", async () => {
    const a = await call("GET", "/patient/records", { token: S.patA.token });
    expectStatus(a, 200, "A list");
    const aIds = new Set(a.data.map((r) => r.id));
    for (const k of ["aadhaar", "prescription", "xray", "blood_test", "ct_scan", "discharge_summary"]) {
      assert.ok(aIds.has(S[k].id), `A sees ${k}`);
    }
    const b = await call("GET", "/patient/records", { token: S.patB.token });
    expectStatus(b, 200, "B list");
    assert.ok(b.data.every((r) => !aIds.has(r.id)), "B sees none of A's documents");
  });

  it("serves a document only through its signed link", async () => {
    const ok = await fetch(S.xray.fileUrl);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/pdf");
    const forged = await fetch(S.xray.fileUrl.replace(/\/files\/([^/.]+)\.([^/]+)\//, "/files/$1.AAAA$2/"));
    assert.equal(forged.status, 404, "a tampered token opens nothing");
  });
});

describe("Ownership on every route", () => {
  it("patient B can neither edit, replace nor remove patient A's document", async () => {
    const patch = await call("PATCH", `/patient/records/${S.xray.id}`, { token: S.patB.token, body: { tag: "hijack" } });
    expectStatus(patch, 404, "B edits A's");
    const put = await call("PUT", `/patient/records/${S.xray.id}/file`, { token: S.patB.token, form: docForm(PDF, "x.pdf", "application/pdf") });
    expectStatus(put, 404, "B replaces A's");
    const del = await call("DELETE", `/patient/records/${S.aadhaar.id}`, { token: S.patB.token });
    expectStatus(del, 404, "B removes A's");
    const still = await UploadedRecord.findByPk(S.aadhaar.id);
    assert.ok(still, "A's Aadhaar still exists");
  });

  it("a doctor's token cannot use the patient document routes", async () => {
    const res = await call("GET", "/patient/records", { token: S.doc.token });
    assert.ok([401, 403].includes(res.status), `doctor on /patient/records → ${res.status}`);
    const anon = await call("GET", "/patient/records");
    expectStatus(anon, 401, "no token");
  });
});

describe("File validation", () => {
  it("rejects executables, active content, renamed files and oversized files", async () => {
    const exe = await upload("patA", Buffer.from("MZ\x90\x00"), "setup.exe", "application/x-msdownload", { documentKind: "other_medical", tag: "x" });
    expectStatus(exe, 422, ".exe");
    const html = await upload("patA", Buffer.from("<script>alert(1)</script>"), "report.html", "image/png", { documentKind: "lab_report", tag: "x" });
    expectStatus(html, 422, ".html sent as image/png");
    const svg = await upload("patA", Buffer.from("<svg/>"), "scan.svg", "image/svg+xml", { documentKind: "xray", tag: "x" });
    expectStatus(svg, 422, ".svg");
    const fakePdf = await upload("patA", Buffer.from("just text, not a pdf"), "report.pdf", "application/pdf", { documentKind: "lab_report", tag: "x" });
    expectStatus(fakePdf, 422, "text renamed .pdf");
    const big = Buffer.alloc(Math.ceil((env.MAX_UPLOAD_MB + 0.5) * 1024 * 1024), 0x20);
    PDF.copy(big);
    const tooBig = await upload("patA", big, "huge.pdf", "application/pdf", { documentKind: "lab_report", tag: "x" });
    expectStatus(tooBig, 422, "over MAX_UPLOAD_MB");
    assert.match(JSON.stringify(tooBig.body ?? {}), /too large/i);
  });

  it("rejects an unknown document kind", async () => {
    const res = await upload("patA", PDF, "a.pdf", "application/pdf", { documentKind: "passport_scan_full", tag: "x" });
    expectStatus(res, 422, "unknown kind");
  });
});

describe("Edit, replace, delete", () => {
  it("edits details and stamps updatedAt; a legacy type change drops a contradicting kind", async () => {
    const res = await call("PATCH", `/patient/records/${S.xray.id}`, {
      token: S.patA.token,
      body: { description: "Follow-up film", doctorName: "Dr. Rao" },
    });
    expectStatus(res, 200, "edit");
    assert.equal(res.data.description, "Follow-up film");
    assert.equal(res.data.doctorName, "Dr. Rao");
    assert.equal(res.data.documentKind, "xray");
    assert.ok(res.data.updatedAt, "updatedAt set");

    const legacy = await call("PATCH", `/patient/records/${S.ct_scan.id}`, { token: S.patA.token, body: { fileType: "prescription" } });
    expectStatus(legacy, 200, "legacy type edit");
    assert.equal(legacy.data.fileType, "prescription");
    assert.equal(legacy.data.documentKind, null, "a CT-scan kind no longer fits a prescription");
  });

  it("keeps last-4 digits on identity documents only", async () => {
    const id = await call("PATCH", `/patient/records/${S.aadhaar.id}`, { token: S.patA.token, body: { idLast4: "9876" } });
    expectStatus(id, 200, "set last4 on Aadhaar");
    assert.equal(id.data.idLast4, "9876");
    const other = await call("PATCH", `/patient/records/${S.xray.id}`, { token: S.patA.token, body: { idLast4: "4321" } });
    expectStatus(other, 200, "last4 on an X-ray");
    assert.equal(other.data.idLast4, null, "ignored outside identity documents");
  });

  it("replaces the file but keeps the document's details, and removes the old file", async () => {
    const before = S.blood_test;
    const res = await call("PUT", `/patient/records/${before.id}/file`, {
      token: S.patA.token,
      form: docForm(PNG, "cbc-photo.png", "image/png"),
    });
    expectStatus(res, 200, "replace");
    assert.notEqual(res.data.fileUrl, before.fileUrl);
    assert.equal(res.data.originalName, "cbc-photo.png");
    assert.equal(res.data.mimeType, "image/png");
    assert.equal(res.data.tag, before.tag);
    assert.equal(res.data.documentKind, "blood_test");
    const fresh = await fetch(res.data.fileUrl);
    assert.equal(fresh.status, 200);
    const old = await fetch(before.fileUrl);
    assert.notEqual(old.status, 200, "the old file is gone");
  });

  it("documents filed by a doctor stay: the patient cannot edit, replace or remove them", async () => {
    const filed = await UploadedRecord.create({
      patientId: S.patA.id,
      fileUrl: "https://example.invalid/doctor-filed.pdf",
      fileType: "prescription",
      tag: `RX-TEST-${RUN}`,
      source: "doctor",
      recordedByUserId: S.doc.id,
    });
    const del = await call("DELETE", `/patient/records/${filed.id}`, { token: S.patA.token });
    expectStatus(del, 403, "remove doctor-filed");
    const patch = await call("PATCH", `/patient/records/${filed.id}`, { token: S.patA.token, body: { tag: "mine" } });
    expectStatus(patch, 403, "edit doctor-filed");
    const put = await call("PUT", `/patient/records/${filed.id}/file`, { token: S.patA.token, form: docForm(PDF, "x.pdf", "application/pdf") });
    expectStatus(put, 403, "replace doctor-filed");
    assert.ok(await UploadedRecord.findByPk(filed.id), "still there");
  });

  it("removes the patient's own upload", async () => {
    const res = await call("DELETE", `/patient/records/${S.discharge_summary.id}`, { token: S.patA.token });
    expectStatus(res, 200, "remove own");
    assert.equal(await UploadedRecord.findByPk(S.discharge_summary.id), null);
  });
});

describe("Identity documents never leave the patient", () => {
  it("clinic / admin reads (getRecords default) leave identity documents out", async () => {
    const rows = await patientService.getRecords(S.patA.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.fileType !== "identity"), "no identity rows");
    const own = await patientService.getRecords(S.patA.id, { includeIdentity: true });
    assert.ok(own.some((r) => r.id === Number(S.aadhaar.id) || String(r.id) === S.aadhaar.id));
  });

  it("the clinic snapshot leaves them out — and still loads a patient with no documents", async () => {
    const a = await patientService.getSnapshotForClinic(S.patA.id);
    assert.ok((a.uploadedRecords ?? []).every((r) => r.fileType !== "identity"));
    const b = await patientService.getSnapshotForClinic(S.patB.id);
    assert.equal(Number(b.id), S.patB.id, "patient without documents still found (LEFT JOIN)");
  });

  it("no doctor scope — even one holding every category — may see an identity document", async () => {
    const scope = clinicalAccess.makeScope(S.doc.id, S.patA.id, CLINICAL_ACCESS_CATEGORIES);
    const row = await UploadedRecord.findByPk(S.aadhaar.id);
    assert.equal(clinicalAccess.recordAllowed(scope, row), false);
    const ownScope = clinicalAccess.makeScope(S.patA.id, S.patA.id, CLINICAL_ACCESS_CATEGORIES);
    assert.equal(clinicalAccess.recordAllowed(ownScope, row), false, "not even via the 'own upload' rule");
  });

  it("a clinic or admin may not file an identity document for a patient", async () => {
    await assert.rejects(
      patientService.uploadRecord(
        S.patA.id,
        { buffer: PNG, originalname: "id.png", mimetype: "image/png", size: PNG.length },
        { documentKind: "aadhaar", tag: "ID" },
        { source: "clinic", userId: S.doc.id }
      ),
      (err) => err.statusCode === 403 || err.status === 403
    );
  });
});
