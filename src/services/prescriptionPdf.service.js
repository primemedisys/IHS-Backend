/**
 * The prescription renderer — the ONLY file in the codebase that knows a
 * browser exists (docs/prescriptions/backend-plan.md §7).
 *
 * Public surface, deliberately tiny, so swapping Chromium for Gotenberg or a
 * print microservice touches one file:
 *
 *   render(snapshot, rx)   -> Buffer     the signed document
 *   renderSample(snapshot) -> Buffer     the template editor's "Preview PDF"
 *   shutdown()                           called from server.js on SIGTERM
 *
 * Two rules the rest of the app relies on:
 *   1. EVERY doctor- and patient-supplied string goes through esc(). The
 *      doctor's credential lines are attacker-controlled with respect to the
 *      patient who opens the PDF.
 *   2. Assets are inlined as data: URIs. Chromium fetching logo_url over the
 *      network is slow, flaky, and broken outright on a private S3 bucket.
 */
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const upload = require("./upload.service");
const cloudStorage = require("./cloudinaryStorage.service");
const { ERROR_CODES } = require("../config/constants");

const SHELL = path.join(__dirname, "..", "templates", "prescriptions", "rx.html");
const PAGE_MM = { A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 } };

// ── escaping ────────────────────────────────────────────────────────────────
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => (v == null ? "" : String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]));

/** For CSS `url("…")` / custom-property values — keep quotes and parens out. */
const cssSafe = (v) => (v == null ? "" : String(v).replace(/["'()\\;{}]/g, ""));

// ── asset inlining ──────────────────────────────────────────────────────────
const assetCache = new Map(); // url -> data: URI (or "" when unreadable)

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * Read an asset's bytes and return a `data:` URI. Local-driver files come off
 * disk; anything else is fetched. A missing/broken asset must never fail the
 * whole render — a prescription without its logo still beats no prescription.
 */
async function assetDataUri(url) {
  if (!url) return "";
  if (assetCache.has(url)) return assetCache.get(url);

  let uri = "";
  try {
    const key = upload.keyFromUrl(url);
    // Contained to UPLOAD_DIR: a stored URL can never point the renderer at another file.
    const localPath = upload.localPathFor(key);

    let buffer;
    let mime;
    if (localPath && fs.existsSync(localPath) && (env.STORAGE_DRIVER === "local" || url.includes("/uploads/"))) {
      // Local file — the active driver, or one stored before a switch to Cloudinary.
      buffer = await fs.promises.readFile(localPath);
      mime = MIME_BY_EXT[path.extname(localPath).toLowerCase()] || "image/png";
    } else if (cloudStorage.parseUrl(url)) {
      // Letterhead/signature assets are private on Cloudinary: read them with
      // the server-side signature, never by fetching the (inert) stored URL.
      buffer = await upload.readByUrl(url);
      if (!buffer) throw new Error("asset not readable");
      mime = upload.contentTypeFor(key);
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      mime = res.headers.get("content-type") || "image/png";
    }
    uri = `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn(`⚠️  Prescription asset unreadable, rendering without it: ${url} (${err.message})`);
  }

  assetCache.set(url, uri);
  return uri;
}

/** Drop an asset from the inline cache when it's replaced or removed. */
const forgetAsset = (url) => assetCache.delete(url);

// ── HTML building ───────────────────────────────────────────────────────────
let shellCache = null;
const shell = () => (shellCache ||= fs.readFileSync(SHELL, "utf8"));

/** `split/join` not `replace` — a `$&` inside the content would corrupt a replace(). */
const substitute = (haystack, token, value) => haystack.split(token).join(value);

const COLUMN_LABELS = {
  medicineName: "Medicine",
  dosage: "Dosage",
  route: "Route",
  frequency: "Frequency",
  timing: "Timing",
  durationDays: "Duration",
  notes: "Notes",
};

const TIMING_LABELS = {
  before_food: "Before food",
  after_food: "After food",
  with_food: "With food",
  anytime: "Anytime",
};

const fmtDate = (d) =>
  !d
    ? ""
    : new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/** The value of one medicine cell, already escaped. */
function cell(item, column) {
  switch (column) {
    case "route":
      return esc(item.route ? item.route[0].toUpperCase() + item.route.slice(1) : "");
    case "timing":
      return esc(TIMING_LABELS[item.timing] ?? "");
    case "durationDays": {
      // The count is qualified by its UNIT (migration 015). Pre-015 rows carry
      // `day`, so they print exactly as they always did.
      if (!item.durationDays) return "";
      const unit = item.durationUnit || "day";
      return esc(`${item.durationDays} ${unit}${item.durationDays > 1 ? "s" : ""}`);
    }
    default:
      return esc(item[column] ?? "");
  }
}

/** ② The patient/vitals strip, grouped into the rows the template assigned. */
function patientStripHtml(fields, values) {
  const enabled = (fields || []).filter((f) => f.enabled);
  if (!enabled.length) return "";

  // The paper letterhead prints one "Age/Sex" box. `age` and `sex` are separate
  // keys, so when only `age` is enabled it carries both — otherwise the
  // patient's sex would silently vanish from the document.
  const showsSex = enabled.some((f) => f.key === "sex");
  const valueFor = (key) => {
    if (key === "age" && !showsSex && values.sex) {
      return values.age ? `${values.age} / ${values.sex}` : values.sex;
    }
    return values[key] ?? "";
  };

  const rows = [1, 2, 3]
    .map((n) => enabled.filter((f) => (f.row ?? 1) === n))
    .filter((group) => group.length);

  return `<div class="patient-strip">${rows
    .map(
      (group) =>
        `<div class="patient-row">${group
          .map((f) => {
            const grow = f.key === "name" || f.key === "address" ? " field--grow" : "";
            return `<div class="field${grow}"><span class="field__label">${esc(
              f.label
            )}</span><span class="field__value">${esc(valueFor(f.key))}</span></div>`;
          })
          .join("")}</div>`
    )
    .join("")}</div>`;
}

/**
 * ③ The Advice sidebar. The reference letterhead pre-prints the whole
 * investigation menu and the doctor circles items — so we print every item and
 * mark the selected ones, rather than printing only the selection.
 */
function sidebarHtml(sidebar, selected) {
  const picked = new Set(selected || []);
  const groups = (sidebar?.groups || []).filter((g) => g.items?.length);
  if (!groups.length) return "";

  const body = groups
    .map(
      (g) =>
        (g.title ? `<div class="sidebar__group-title">${esc(g.title)}</div>` : "") +
        `<ul>${g.items
          .map((i) => {
            const on = picked.has(i);
            return `<li class="${on ? "ticked" : ""}"><span class="mark">${
              on ? "&#10003;" : "&bull;"
            }</span><span>${esc(i)}</span></li>`;
          })
          .join("")}</ul>`
    )
    .join("");

  return `<aside class="sidebar">
    ${sidebar.title ? `<div class="sidebar__title">${esc(sidebar.title)}</div>` : ""}
    ${body}
  </aside>`;
}

function vitalsHtml(v) {
  // BP, Weight, Height are already shown in the patient strip header —
  // only include vitals that aren't duplicated there.
  const parts = [
    v.pulseRateBpm && ["Pulse", `${v.pulseRateBpm} bpm`],
    v.temperatureF && ["Temp", `${v.temperatureF} °F`],
    v.spo2Percent && ["SpO2", `${v.spo2Percent}%`],
  ].filter(Boolean);

  if (!parts.length) return "";
  return `<div class="section"><div class="section__label">Vitals</div><div class="vitals">${parts
    .map(([k, val]) => `<span>${esc(k)}: <b>${esc(val)}</b></span>`)
    .join("")}</div></div>`;
}

function medsHtml(columns, items) {
  if (!items?.length) return `<div class="meds-empty">No medicines prescribed.</div>`;
  return `<table class="meds">
    <thead><tr>${columns.map((c) => `<th>${esc(COLUMN_LABELS[c] ?? c)}</th>`).join("")}</tr></thead>
    <tbody>${items
      .map(
        (it) =>
          `<tr>${columns
            .map((c) => `<td class="${c === "medicineName" ? "name" : ""}">${cell(it, c)}</td>`)
            .join("")}</tr>`
      )
      .join("")}</tbody>
  </table>`;
}

/** Build the whole document. `rx` is the view object from prescription.service. */
async function buildHtml(snapshot, rx) {
  const s = snapshot;
  const body = s.bodyJson ?? {};
  const header = s.headerJson ?? {};

  const [logo, watermark, signature] = await Promise.all([
    s.showHeader ? assetDataUri(s.logoUrl) : "",
    s.showWatermark ? assetDataUri(s.watermarkUrl) : "",
    assetDataUri(s.signatureUrl),
  ]);

  const page = PAGE_MM[s.pageSize] ?? PAGE_MM.A4;
  const padX = Math.max(s.marginMmLeft ?? 8, s.marginMmRight ?? 8);

  const styleVars = [
    `--header-bg: ${cssSafe(s.headerBgColor)};`,
    `--header-text: ${cssSafe(s.headerTextColor)};`,
    `--footer-bg: ${cssSafe(s.footerBgColor)};`,
    `--footer-text: ${cssSafe(s.footerTextColor)};`,
    `--accent: ${cssSafe(s.accentColor)};`,
    `--font: ${cssSafe(s.fontFamily)};`,
    `--base: ${Number(s.baseFontSizePt) || 10}pt;`,
    `--wm-opacity: ${Number(s.watermarkOpacity) || 0};`,
    `--sidebar-width: ${Number(s.sidebarWidthPct) || 18}%;`,
    `--page-size: ${cssSafe(s.pageSize) || "A4"};`,
    `--pad-x: ${padX}mm;`,
    `--watermark: ${watermark ? `url("${watermark}")` : "none"};`,
  ].join("\n        ");

  // ① header
  const credentials = (header.credentialLines || [])
    .map((line, i) => `<li class="${i === 0 ? "" : "dim"}">${esc(line)}</li>`)
    .join("");
  const brand =
    logo || header.clinicName
      ? `<div class="rx-header__brand">
           ${logo ? `<img src="${logo}" alt="" />` : ""}
           ${header.clinicName ? `<div class="clinic-name">${esc(header.clinicName)}</div>` : ""}
           ${header.clinicTagline ? `<div class="clinic-tagline">${esc(header.clinicTagline)}</div>` : ""}
         </div>`
      : "";
  const headerHtml = s.showHeader
    ? `<header class="rx-header ${header.logoPosition === "left" ? "logo-left" : ""}">
         <div class="rx-header__text">
           <div class="doctor-name">${esc(header.doctorNameLine)}</div>
           <ul class="credentials">${credentials}</ul>
           ${
             header.regNoValue
               ? `<div class="reg-no">${esc(header.regNoLabel || "Regd. No.")} ${esc(header.regNoValue)}</div>`
               : ""
           }
         </div>
         ${brand}
       </header>`
    : "";

  // ④ body
  const meta = [
    rx.rxNumber && `<div>Rx No: <b>${esc(rx.rxNumber)}</b></div>`,
    `<div>Date: <b>${esc(fmtDate(rx.date))}</b></div>`,
  ]
    .filter(Boolean)
    .join("");

  const sections = [
    body.showVitals ? vitalsHtml(rx.vitals ?? {}) : "",
    rx.chiefComplaint
      ? `<div class="section"><div class="section__label">Chief complaint</div><div class="section__value">${esc(
          rx.chiefComplaint
        )}</div></div>`
      : "",
    body.showDiagnosis && rx.diagnosis
      ? `<div class="section"><div class="section__label">Diagnosis</div><div class="section__value">${esc(
          rx.diagnosis
        )}</div></div>`
      : "",
    `<div class="section">
       ${body.rxSymbol ? `<div class="rx-symbol">&#8478;</div>` : ""}
       ${medsHtml(body.medicineColumns || ["medicineName", "dosage", "frequency"], rx.items || [])}
     </div>`,
    (rx.investigations || []).length
      ? `<div class="section"><div class="section__label">Investigations</div><div class="section__value">${esc(
          rx.investigations.map((line, i) => `${i + 1}. ${line}`).join("\n")
        )}</div></div>`
      : "",
    body.showAdviceText && rx.advice
      ? `<div class="section"><div class="section__label">Advice</div><div class="section__value">${esc(
          rx.advice
        )}</div></div>`
      : "",
    rx.notes
      ? `<div class="section"><div class="section__label">Notes</div><div class="section__value">${esc(
          rx.notes
        )}</div></div>`
      : "",
    body.showFollowUp && rx.followUpDate
      ? `<div class="section"><div class="section__label">Follow-up</div><div class="section__value">${esc(
          [fmtDate(rx.followUpDate), rx.followUpNote].filter(Boolean).join(" — ")
        )}</div></div>`
      : "",
  ].join("");

  const signatureHtml = `<div class="signature">
      ${signature ? `<img src="${signature}" alt="" />` : ""}
      <div class="signature__rule"><div class="signature__name">${esc(
        header.doctorNameLine
      )}</div></div>
    </div>`;

  // ⑥ footer
  const footerHtml = s.showFooter
    ? `<footer class="rx-footer">${(s.footerJson?.columns || [])
        .map(
          (c) =>
            `<div class="rx-footer__col">
               ${c.title ? `<div class="rx-footer__title">${esc(c.title)}</div>` : ""}
               ${(c.lines || []).map((l) => `<div class="rx-footer__line">${esc(l)}</div>`).join("")}
             </div>`
        )
        .join("")}</footer>`
    : "";

  const content = `<div class="page">
      ${headerHtml}
      ${patientStripHtml(s.patientFieldsJson, rx.patient ?? {})}
      <div class="main">
        ${watermark ? `<div class="watermark"></div>` : ""}
        ${s.showSidebar ? sidebarHtml(s.sidebarJson, rx.adviceSelected) : ""}
        <section class="rx-body">
          <div class="rx-body__top"><div class="rx-meta">${meta}</div></div>
          ${sections}
          ${signatureHtml}
          ${body.disclaimer ? `<div class="disclaimer">${esc(body.disclaimer)}</div>` : ""}
        </section>
      </div>
      ${footerHtml}
    </div>`;

  return substitute(substitute(shell(), "__STYLE_VARS__", styleVars), "__CONTENT__", content);
}

// ── Chromium ────────────────────────────────────────────────────────────────
//
// Finding a browser on a deployed box is the #1 way this file fails. `npm ci`
// on a server routinely skips or discards Puppeteer's Chromium download (the
// build layer's ~/.cache is not the runtime's), so we do NOT assume the bundled
// binary exists. Resolution order:
//   1. PUPPETEER_EXECUTABLE_PATH  — an explicit operator override always wins;
//   2. Puppeteer's own download   — the normal dev/laptop case;
//   3. a distro package           — `apt-get install chromium` and it just works,
//                                   no env var to remember.
const SYSTEM_CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/usr/lib/chromium/chromium",
];

/** How to get a browser onto the box — printed with the failure, not buried in a doc. */
const NO_BROWSER_HELP = [
  "No Chrome/Chromium found for PDF rendering. On the server, either:",
  "  cd <app>/backend && npx puppeteer browsers install chrome",
  "  npx playwright install-deps chromium        # installs the OS libraries Chromium needs",
  "or install a distro package and point at it:",
  "  sudo apt-get install -y chromium && export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium",
].join("\n  ");

async function resolveExecutablePath(puppeteer) {
  if (env.PUPPETEER_EXECUTABLE_PATH) return env.PUPPETEER_EXECUTABLE_PATH;
  try {
    // Puppeteer 25 resolves this ASYNCHRONOUSLY (older majors returned the
    // string directly) — `await` handles both, and the typeof guard means a
    // future shape change degrades to the system search instead of throwing.
    const bundled = await puppeteer.executablePath();
    if (typeof bundled === "string" && bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Throws when no browser was ever downloaded — fall through to the system.
  }
  const system = SYSTEM_CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!system) throw new Error(NO_BROWSER_HELP);
  return system;
}

let browserPromise = null;

/**
 * One browser per process; a fresh PAGE per render. Launching per request costs
 * ~800ms and leaks.
 *
 * Two things this must never do, both of which turn a transient fault into a
 * permanent one that only a restart clears:
 *   • cache a REJECTED promise — every later render would re-await the same
 *     failure even after Chromium was installed;
 *   • keep a handle to a browser that has since died (the OOM killer takes
 *     Chromium first on a small box) — `disconnected` drops it so the next
 *     render launches a fresh one.
 */
function browser() {
  if (!browserPromise) {
    // eslint-disable-next-line global-require
    const puppeteer = require("puppeteer");
    const launched = (async () => {
      const executablePath = await resolveExecutablePath(puppeteer);
      const b = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"], // required in most containers
      });
      b.on("disconnected", () => {
        if (browserPromise === launched) browserPromise = null;
      });
      return b;
    })();

    browserPromise = launched.catch((err) => {
      if (browserPromise === launched) browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Prove at BOOT that a prescription can actually be rendered, instead of finding
 * out when a doctor clicks "View". Never throws — a broken renderer must not
 * stop the API from serving everything else. Also warms the singleton, so the
 * first real render doesn't pay the ~800ms launch.
 */
async function preflight() {
  if (env.PDF_ENGINE === "none") {
    console.log("ℹ️  PDF rendering disabled (PDF_ENGINE=none)");
    return false;
  }
  try {
    const b = await browser();
    console.log(`✅ PDF renderer ready (${await b.version()})`);
    return true;
  } catch (err) {
    console.error(
      `❌ PDF renderer UNAVAILABLE — prescriptions will fail to render.\n  ${err.message}`
    );
    return false;
  }
}

// Chromium pages are memory-hungry; bound how many render at once.
let active = 0;
const queue = [];
const acquire = () =>
  active < env.PDF_MAX_CONCURRENCY
    ? ((active += 1), Promise.resolve())
    : new Promise((resolve) => queue.push(resolve));
const release = () => {
  const next = queue.shift();
  if (next) next();
  else active -= 1;
};

async function toPdf(html, snapshot) {
  await acquire();
  let page;
  try {
    page = await (await browser()).newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: env.PDF_TIMEOUT_MS });
    const bytes = await page.pdf({
      format: snapshot.pageSize === "Letter" ? "Letter" : "A4",
      printBackground: true, // without this the coloured header/footer bars vanish
      margin: { top: "0", right: "0", bottom: "0", left: "0" }, // full-bleed bars; padding lives in CSS
      timeout: env.PDF_TIMEOUT_MS,
    });
    // Puppeteer >= 23 resolves a Uint8Array, not a Buffer. `res.send()` would
    // JSON-serialize that into `{"0":37,"1":80,…}` instead of sending a PDF.
    return Buffer.from(bytes);
  } finally {
    if (page) await page.close().catch(() => {}); // ALWAYS — a leaked page is a leaked tab
    release();
  }
}

async function toBuffer(snapshot, rx) {
  if (env.PDF_ENGINE === "none") {
    throw new ApiError(503, "PDF rendering is disabled on this server", {
      code: ERROR_CODES.PDF_RENDER_FAILED,
    });
  }
  try {
    return await toPdf(await buildHtml(snapshot, rx), snapshot);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error("❌ Prescription PDF render failed:", err);
    // Carry the real cause up. Without it the client sees a bare "Could not
    // build the prescription PDF" and the only way to learn WHY is shell access
    // to the server — which is exactly how this stayed a mystery in production.
    throw new ApiError(500, "Could not build the prescription PDF", {
      code: ERROR_CODES.PDF_RENDER_FAILED,
      details: { reason: err.message },
    });
  }
}

/** The fake patient the template editor previews against. */
const SAMPLE_RX = {
  rxNumber: "SAMPLE-0001",
  date: new Date(),
  patient: {
    name: "Ramananda Pattnaik",
    age: "28",
    sex: "M",
    phone: "90000 00000",
    address: "Bhubaneswar",
    bp: "130/85",
    pulse: "78",
    weight: "72",
    height: "171",
    temperature: "98.4",
    spo2: "98",
    date: "",
  },
  vitals: {
    bloodPressure: "130/85",
    pulseRateBpm: 78,
    weightKg: 72,
    heightCm: 171,
    temperatureF: 98.4,
    spo2Percent: 98,
  },
  chiefComplaint: "Low back pain radiating to the left leg, 3 weeks",
  diagnosis: "L4–L5 disc bulge with radiculopathy",
  advice: "Avoid forward bending and heavy lifting. Hot fomentation twice daily.",
  adviceSelected: [],
  notes: null,
  followUpDate: new Date(Date.now() + 14 * 864e5),
  items: [
    { medicineName: "Tab. Etoricoxib 90mg", dosage: "1 tab", route: "oral", frequency: "OD", timing: "after_food", durationDays: 5, notes: null },
    { medicineName: "Cap. Pregabalin 75mg", dosage: "1 cap", route: "oral", frequency: "HS", timing: "after_food", durationDays: 10, notes: null },
    { medicineName: "Tab. Calcium + Vit D3", dosage: "1 tab", route: "oral", frequency: "OD", timing: "after_food", durationDays: 30, notes: null },
  ],
};

module.exports = {
  render: (snapshot, rx) => toBuffer(snapshot, rx),

  /** Preview a letterhead against sample data. Never stored. */
  renderSample: (snapshot) => {
    // Tick a few sidebar items so the doctor can see how a selection prints.
    const firstItems = snapshot.sidebarJson?.groups?.[0]?.items?.slice(0, 3) ?? [];
    return toBuffer(snapshot, { ...SAMPLE_RX, adviceSelected: firstItems });
  },

  forgetAsset,
  preflight,
  SAMPLE_RX,
  buildHtml, // exported for tests/inspection — the PDF is still the authority

  async shutdown() {
    if (!browserPromise) return;
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  },
};
