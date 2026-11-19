/**
 * Upload / stored-URL hardening — end-to-end regression tests.
 *
 *  - A record whose pasted URL points outside the upload folder
 *    (`…/uploads/../<file>`) can be deleted without touching that file.
 *  - Only http(s) URLs are accepted for pasted records (no `javascript:`).
 *  - A page or script disguised as an image (`evil.html` sent as image/png)
 *    is refused at upload.
 *  - Stored files that are not passive formats are served as downloads, never
 *    rendered inline from the API origin.
 *
 * Run against an already-running API that uses the LOCAL storage driver:
 *   SECURITY_E2E_BASE_URL=http://localhost:5055 node --test test/security/uploadHardening.test.js
 */
const path = require("path");
const fs = require("fs");

const EXTERNAL = process.env.SECURITY_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { sequelize, User } = require("../../src/models");
const env = require("../../src/config/env");

const RUN = Date.now().toString(36);
let base;
let server;
const S = {};

async function call(method, urlPath, { token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(raw ? urlPath : `${base}/api${urlPath}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, data: json?.data, headers: res.headers, text };
}

const fileForm = (content, name, type, fileType = "lab_report") => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(content)], { type }), name);
  form.append("fileType", fileType);
  return form;
};

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) base = EXTERNAL.replace(/\/+$/, "");
  else {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const res = await call("POST", "/auth/register", {
    body: { name: `Sec Tester${RUN}`, email: `sec-${RUN}@ihs-test.example.com`, password: "SecTest#2026x", role: "patient" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  S.id = res.data.user.id;
  S.token = res.data.tokens.accessToken;
});

after(async () => {
  if (S.canary && fs.existsSync(S.canary)) fs.rmSync(S.canary, { force: true });
  if (EXTERNAL && S.id) await User.update({ isActive: false }, { where: { id: S.id } });
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Stored-URL hardening", () => {
  it("deleting a record with a traversal URL leaves the outside file alone", { skip: env.STORAGE_DRIVER !== "local" }, async () => {
    // A canary file just OUTSIDE the upload folder.
    const uploadRoot = path.resolve(env.UPLOAD_DIR);
    S.canary = path.join(path.dirname(uploadRoot), `canary-${RUN}.txt`);
    fs.writeFileSync(S.canary, "must survive");
    const traversal = `http://x/uploads/../${path.basename(S.canary)}`;

    const add = await call("POST", "/patient/records", { token: S.token, body: { fileUrl: traversal, fileType: "other" } });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const id = add.data.id ?? add.data.record?.id;
    const del = await call("DELETE", `/patient/records/${id}`, { token: S.token });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(fs.existsSync(S.canary), "the file outside UPLOAD_DIR was not deleted");
  });

  it("only accepts http(s) record links", async () => {
    const res = await call("POST", "/patient/records", { token: S.token, body: { fileUrl: "javascript:alert(1)", fileType: "other" } });
    assert.equal(res.status, 422);
  });
});

describe("Upload hardening", () => {
  it("refuses a page disguised as an image", async () => {
    const res = await call("POST", "/patient/records/upload", {
      token: S.token,
      form: fileForm("<html><script>alert(1)</script></html>", "evil.html", "image/png"),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "UNSUPPORTED_FILE_TYPE");
  });

  it("serves non-passive formats as downloads and passive ones inline", { skip: env.STORAGE_DRIVER !== "local" }, async () => {
    const rtf = await call("POST", "/patient/records/upload", {
      token: S.token,
      form: fileForm("{\\rtf1 report}", "report.rtf", "application/rtf"),
    });
    assert.equal(rtf.status, 201, JSON.stringify(rtf.body));
    const rtfUrl = rtf.data.fileUrl ?? rtf.data.record?.fileUrl;
    const got = await call("GET", rtfUrl.replace(/^https?:\/\/[^/]+/, base), { raw: true });
    assert.equal(got.status, 200);
    assert.match(got.headers.get("content-disposition") || "", /attachment/);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");

    const pdf = await call("POST", "/patient/records/upload", {
      token: S.token,
      form: fileForm("%PDF-1.4 sec", "scan.pdf", "application/pdf"),
    });
    assert.equal(pdf.status, 201);
    const pdfUrl = pdf.data.fileUrl ?? pdf.data.record?.fileUrl;
    const inline = await call("GET", pdfUrl.replace(/^https?:\/\/[^/]+/, base), { raw: true });
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get("content-disposition"), null, "a PDF still opens inline");
  });
});
