/**
 * Cloudinary storage driver + private file links — isolated tests.
 *
 * No database and no network: the Cloudinary SDK is replaced by an in-memory
 * fake (config/cloudinary `_setCloudinaryForTests`), and `fetch` to Cloudinary
 * hosts is answered from that fake. These prove OUR logic — classification,
 * URL parsing, signing, streaming, failure handling — not Cloudinary itself;
 * a real-account check is in CLOUDINARY_SETUP.md §"Verifying with your account".
 *
 *   node --test test/storage/cloudinaryStorage.test.js
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

require("../testEnv");
const UPLOAD_DIR = path.join(__dirname, "..", ".uploads-storage-test");
Object.assign(process.env, {
  STORAGE_DRIVER: "cloudinary",
  CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "111111111111111",
  CLOUDINARY_API_SECRET: "test-secret-never-real",
  CLOUDINARY_FOLDER: "ihs-test",
  UPLOAD_DIR,
  PUBLIC_URL: "http://localhost:5000",
});
fs.mkdirSync(UPLOAD_DIR, { recursive: true }); // so app.js mounts /uploads for legacy files

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// ── In-memory Cloudinary ─────────────────────────────────────────────────────
const assets = new Map(); // `${resource}:${type}:${public_id}` -> { buffer, format }
const id = (resource, type, publicId) => `${resource}:${type}:${publicId}`;
const fake = {
  failNextUpload: null,
  failDestroy: false,
  uploader: {
    upload_stream(opts, cb) {
      return {
        end(buffer) {
          setImmediate(() => {
            if (fake.failNextUpload) {
              const err = fake.failNextUpload;
              fake.failNextUpload = null;
              return cb(err);
            }
            const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
            if (opts.resource_type === "image" && !isPng) return cb({ message: "Invalid image file", http_code: 400 });
            const format = opts.resource_type === "image" ? "png" : undefined;
            assets.set(id(opts.resource_type, opts.type, opts.public_id), { buffer, format });
            return cb(null, { public_id: opts.public_id, type: opts.type, resource_type: opts.resource_type, version: 1761400000, format, bytes: buffer.length });
          });
        },
      };
    },
    async destroy(publicId, opts) {
      if (fake.failDestroy) throw new Error("network down");
      return { result: assets.delete(id(opts.resource_type, opts.type, publicId)) ? "ok" : "not found" };
    },
  },
  utils: {
    private_download_url: (publicId, format, opts) =>
      `https://api.cloudinary.com/v1_1/demo-cloud/${opts.resource_type}/download?public_id=${encodeURIComponent(publicId)}&type=${opts.type}&expires_at=${opts.expires_at}&signature=fake`,
  },
  url: (publicId, opts) => `https://res.cloudinary.com/demo-cloud/${opts.resource_type}/${opts.type}/s--sig--/v${opts.version}/${publicId}`,
  api: { ping: async () => ({ status: "ok" }) },
};

const realFetch = global.fetch;
const cloudFetches = [];
global.fetch = async (input, init) => {
  const url = String(input);
  if (!/^https:\/\/(api|res)\.cloudinary\.com\//.test(url)) return realFetch(input, init);
  cloudFetches.push(url);
  const u = new URL(url);
  let asset;
  if (u.host === "api.cloudinary.com") {
    const [, , , resource] = u.pathname.split("/");
    if (u.searchParams.get("signature")) asset = assets.get(id(resource, u.searchParams.get("type"), u.searchParams.get("public_id")));
  } else {
    const m = /^\/demo-cloud\/(image|raw)\/(upload|authenticated)\/(?:[^/]+\/)*?v\d+\/(.+)$/.exec(u.pathname);
    if (m && (m[2] === "upload" || u.pathname.includes("/s--"))) {
      const file = decodeURIComponent(m[3]);
      asset = assets.get(id(m[1], m[2], m[1] === "image" ? file.replace(/\.[^.]+$/, "") : file)) || assets.get(id(m[1], m[2], file));
    }
  }
  return asset ? new Response(asset.buffer, { status: 200 }) : new Response("no", { status: 401 });
};

require("../../src/config/cloudinary")._setCloudinaryForTests(fake);
const upload = require("../../src/services/upload.service");
const cloud = require("../../src/services/cloudinaryStorage.service");
const fileAccess = require("../../src/services/fileAccess.service");
const fileUrlReplacer = require("../../src/utils/fileUrlReplacer");
const env = require("../../src/config/env");

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml fake zip body")]);

let base;
let server;
const queueExisted = fs.existsSync(cloud.CLEANUP_QUEUE_FILE);

before(async () => {
  const app = require("../../src/app"); // eslint-disable-line global-require
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  if (!queueExisted) fs.rmSync(cloud.CLEANUP_QUEUE_FILE, { force: true });
  global.fetch = realFetch;
  await require("../../src/models").sequelize.close(); // eslint-disable-line global-require
});

/** Fetch a URL the API handed out, against the in-process server. */
const open = (url) => realFetch(url.replace(/^https?:\/\/[^/]+/, base));

describe("Cloudinary driver — uploads", () => {
  it("stores a public image on the CDN (`image/upload`) and delivers it optimised", async () => {
    const stored = await upload.put(PNG, { keyPrefix: "doctor/5/photo", filename: "face.png", mimetype: "image/png" });
    assert.match(stored.url, /^https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/v1761400000\/ihs-test\/doctor\/5\/photo\/[0-9a-f-]{36}-face\.png$/);
    assert.equal(upload.keyFromUrl(stored.url), stored.key);
    const delivered = fileAccess.deliveryUrl(stored.url);
    assert.match(delivered, /\/image\/upload\/c_limit,w_1600,f_auto,q_auto\/v1761400000\//);
    assert.equal(upload.keyFromUrl(delivered), stored.key, "an echoed transformed URL still maps to the same asset");
  });

  it("stores a patient record PDF as a private `raw/authenticated` asset", async () => {
    const stored = await upload.put(PDF, { keyPrefix: "patient/9/records", filename: "Blood Report.pdf", mimetype: "application/pdf" });
    assert.match(stored.url, /\/raw\/authenticated\/v\d+\/ihs-test\/patient\/9\/records\/[0-9a-f-]{36}-Blood_Report\.pdf$/);
    const res = await fetch(stored.url); // the in-memory Cloudinary, like the real one, demands a signature
    assert.equal(res.status, 401, "the stored URL itself is inert without a server signature");
  });

  it("stores Word documents as `raw`, never as an image", async () => {
    const stored = await upload.put(DOCX, { keyPrefix: "doctor/5/docs", filename: "degree.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    assert.match(stored.url, /\/raw\/authenticated\//);
  });

  it("refuses bytes that are not the format the name claims, before storing anything", async () => {
    const before = assets.size;
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    for (const filename of ["scan.pdf", "photo.png", "notes.docx"]) {
      await assert.rejects(upload.put(html, { keyPrefix: "patient/9/records", filename, mimetype: "application/pdf" }), (e) => e.statusCode === 422 && e.code === "UNSUPPORTED_FILE_TYPE");
    }
    assert.equal(assets.size, before, "nothing reached storage");
  });

  it("maps a Cloudinary rejection to 422 and an outage to 502 (never a raw 500)", async () => {
    fake.failNextUpload = { message: "Invalid image file", http_code: 400 };
    await assert.rejects(upload.put(PNG, { keyPrefix: "doctor/5/gallery", filename: "x.png", mimetype: "image/png" }), (e) => e.statusCode === 422);
    fake.failNextUpload = { message: "ECONNRESET" };
    await assert.rejects(upload.put(PNG, { keyPrefix: "doctor/5/gallery", filename: "x.png", mimetype: "image/png" }), (e) => e.statusCode === 502 && e.code === "STORAGE_UNAVAILABLE");
  });

  it("storeThen discards the new asset when the DB write fails", async () => {
    const before = assets.size;
    await assert.rejects(
      upload.storeThen(PDF, { keyPrefix: "patient/9/records", filename: "r.pdf", mimetype: "application/pdf" }, async () => {
        throw new Error("db down");
      }),
      /db down/
    );
    assert.equal(assets.size, before, "no orphan left behind");
  });

  it("delete never throws; a failed delete is queued for cleanup", async () => {
    const stored = await upload.put(PNG, { keyPrefix: "medicine/masters/3/images", filename: "box.png", mimetype: "image/png" });
    fake.failDestroy = true;
    await upload.remove(stored.key); // must not throw
    fake.failDestroy = false;
    const queued = fs.readFileSync(cloud.CLEANUP_QUEUE_FILE, "utf8");
    assert.ok(queued.includes(stored.key));
    const assetId = id("image", "upload", `ihs-test/${stored.key.replace(/\.png$/, "")}`);
    assert.ok(assets.has(assetId), "the failed delete left the asset (nothing lost)");
    await upload.remove(stored.key); // the retry
    assert.equal(assets.has(assetId), false);
  });
});

describe("Stored-URL parsing", () => {
  it("only recognises OUR cloud and root folder, and safe keys", () => {
    const ok = "https://res.cloudinary.com/demo-cloud/raw/authenticated/v1/ihs-test/patient/1/records/a.pdf";
    assert.equal(cloud.parseUrl(ok).key, "patient/1/records/a.pdf");
    assert.equal(cloud.parseUrl(ok.replace("demo-cloud", "other-cloud")), null);
    assert.equal(cloud.parseUrl(ok.replace("ihs-test/", "elsewhere/")), null);
    assert.equal(cloud.parseUrl(ok.replace("records/a.pdf", "records/../../x.pdf")), null);
    assert.equal(upload.keyFromUrl("https://example.com/report.pdf"), null);
  });
});

describe("Private file links (/api/files)", () => {
  it("serves an authorised private PDF inline, never cached publicly, embeddable cross-origin", async () => {
    const stored = await upload.put(PDF, { keyPrefix: "diagnostic/4/patients/9/reports", filename: "cbc.pdf", mimetype: "application/pdf" });
    const link = fileAccess.deliveryUrl(stored.url);
    assert.match(link, /^http:\/\/localhost:5000\/api\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/cbc\.pdf$/);
    assert.ok(!link.includes("cloudinary"), "no storage URL or Cloudinary signature reaches the client");
    const res = await open(link);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-disposition"), null, "PDF opens inline");
    assert.match(res.headers.get("cache-control"), /^private, max-age=\d+$/);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PDF));
    assert.ok(cloudFetches.some((u) => u.startsWith("https://api.cloudinary.com/") && u.includes("expires_at=")), "read server-side with an expiring signature");
  });

  it("serves Word documents as a download", async () => {
    const stored = await upload.put(DOCX, { keyPrefix: "clinics/8/documents", filename: "licence.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const res = await open(fileAccess.deliveryUrl(stored.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /wordprocessingml/);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
  });

  it("rejects forged and expired links", async () => {
    const stored = await upload.put(PDF, { keyPrefix: "patient/9/records", filename: "a.pdf", mimetype: "application/pdf" });
    const link = fileAccess.deliveryUrl(stored.url);
    const [token] = link.split("/files/")[1].split("/");
    const [payload] = token.split(".");
    const forged = `${payload}.${crypto.randomBytes(32).toString("base64url")}`;
    assert.equal((await open(link.replace(token, forged))).status, 404);
    // Swap in another file's reference under the old signature.
    const other = Buffer.from(JSON.stringify({ r: stored.url.replace("a.pdf", "b.pdf"), e: 9999999999 })).toString("base64url");
    assert.equal((await open(link.replace(payload, other))).status, 404);
    const longAgo = Math.floor(Date.now() / 1000) - 3 * env.FILE_URL_TTL_MINUTES * 60;
    const expired = `${base}/api/files/${fileAccess.signRef(stored.url, longAgo)}/a.pdf`;
    const res = await open(expired);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "FILE_LINK_EXPIRED");
  });

  it("links are stable within a TTL window (browser cache keeps working)", async () => {
    const ref = "https://res.cloudinary.com/demo-cloud/raw/authenticated/v1/ihs-test/patient/1/records/a.pdf";
    assert.equal(fileAccess.deliveryUrl(ref), fileAccess.deliveryUrl(ref));
  });

  it("the JSON replacer rewrites private refs anywhere in a response and leaves everything else", () => {
    const priv = "https://res.cloudinary.com/demo-cloud/raw/authenticated/v1/ihs-test/prescriptions/3/x-rx.pdf";
    const pub = "https://res.cloudinary.com/demo-cloud/image/upload/v1/ihs-test/doctor/3/photo/x-a.png";
    const out = JSON.parse(
      JSON.stringify({ data: { pdfUrl: priv, doctor: { photoUrl: pub }, list: [{ fileUrl: priv }], link: "https://example.com/uploads/report.pdf", note: "hello" } }, fileUrlReplacer)
    );
    assert.match(out.data.pdfUrl, /\/api\/files\/.+\/x-rx\.pdf$/);
    assert.match(out.data.list[0].fileUrl, /\/api\/files\//);
    assert.match(out.data.doctor.photoUrl, /\/f_auto,q_auto\/|c_limit/);
    assert.equal(out.data.link, "https://example.com/uploads/report.pdf", "a pasted external link is untouched");
    assert.equal(out.data.note, "hello");
  });
});

describe("Existing local files after switching to Cloudinary", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const priv = `patient/77/records/${uuid}-old-report.pdf`;
  const pub = `doctor/77/photo/${uuid}-old-face.png`;
  before(() => {
    for (const [key, buf] of [[priv, PDF], [pub, PNG]]) {
      fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, key)), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, key), buf);
    }
  });

  it("legacy public images still load from /uploads", async () => {
    const res = await realFetch(`${base}/uploads/${pub}`);
    assert.equal(res.status, 200);
  });

  it("legacy private files are no longer public at /uploads — only via signed links", async () => {
    assert.equal((await realFetch(`${base}/uploads/${priv}`)).status, 404);
    assert.equal((await realFetch(`${base}/uploads/doctor/77/photo/..%2F..%2F..%2F${priv}`)).status, 404, "no traversal from a public prefix");
    assert.equal((await realFetch(`${base}/uploads/doctor/77/photo/..%5C..%5C..%5C${priv.replace(/\//g, "%5C")}`)).status, 404);
    const legacyUrl = `http://localhost:5055/uploads/${priv}`; // stored by an API on another port
    const link = fileAccess.deliveryUrl(legacyUrl);
    assert.match(link, /\/api\/files\/.+\/old-report\.pdf$/);
    const res = await open(link);
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PDF), "read from the original local file");
  });
});

describe("Configuration", () => {
  it("missing Cloudinary credentials fail fast with a clear message and no secret in it", () => {
    const res = spawnSync(process.execPath, ["-e", "require('./src/config/env')"], {
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, STORAGE_DRIVER: "cloudinary", CLOUDINARY_API_KEY: "987654321987654", CLOUDINARY_API_SECRET: "" },
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CLOUDINARY_API_SECRET/);
    assert.ok(!res.stderr.includes("987654321987654") && !res.stderr.includes("test-secret-never-real"));
  });
});
