# Prescriptions — Backend Plan

**Read `README.md` first.** This file is the layer-by-layer build order for `backend/`. It assumes the conventions already enforced across this codebase: layered flow `route → validate → authenticate → authorize → resolveDoctorId → controller → service → model`, **Joi-only** validation, thin controllers, no queries in loops, and the `{ success, message, data }` envelope from `utils/apiResponse.js`.

---

## 1. New files at a glance

```
src/
  config/
    constants.js                     ← EXTEND: error codes + prescription enums
    env.js                           ← EXTEND: PDF_* and RX_* vars
  db/migrations/
    006_prescriptions.sql            ← NEW
  models/
    prescriptionTemplate.model.js    ← NEW
    prescription.model.js            ← NEW
    prescriptionItem.model.js        ← NEW
    index.js                         ← EXTEND: associations
  services/
    prescriptionTemplate.service.js  ← NEW
    prescription.service.js          ← NEW
    prescriptionPdf.service.js       ← NEW  (the only file that knows about Chromium)
    mail.service.js                  ← EXTEND: sendPrescriptionReady
  validators/
    prescription.validator.js        ← NEW
  controllers/
    prescriptionTemplate.controller.js ← NEW
    prescription.controller.js         ← NEW
    patientPrescription.controller.js  ← NEW
  routes/
    doctorPrescription.routes.js     ← NEW  (mounted under /doctor)
    patient.routes.js                ← EXTEND: /patient/prescriptions
  templates/
    prescriptions/rx.html            ← NEW  (the letterhead, as HTML+CSS)
    emails/prescription-ready.html   ← NEW
  utils/
    serializers.js                   ← EXTEND
    rxNumber.js                      ← NEW
```

---

## 2. The schema decision, stated once

`prescription_templates` mixes **scalar columns** and **JSON columns**, on one rule:

> A field gets a real column if the *database* ever needs it — to filter, sort, enforce uniqueness, or cascade a delete. A field lives in JSON if it is only ever read whole, by the renderer, on its way to a PDF.

So `is_default`, `clinic_id`, `is_active`, `logo_url`, `header_bg_color` are columns (queried, indexed, or cleaned up on delete). `credentialLines`, `sidebar.groups[].items`, `footer.columns[].lines` are JSON — the doctor drags them around, nothing ever queries them, and normalizing them would buy three tables, three sort-order columns, and three joins per render for exactly zero capability.

The corollary, which is not optional: **every JSON blob is Joi-validated on write** (§5). A JSON column is not an excuse to skip validation — it is the one place where skipping it puts doctor-supplied strings straight into rendered HTML.

---

## 3. Migration `006_prescriptions.sql`

```sql
-- ============================================================================
-- 006  PRESCRIPTIONS & CONFIGURABLE LETTERHEAD
--   Supersedes the sketch in docs/dbstruct.md §14–15 (never migrated).
-- ============================================================================

-- 1. TEMPLATES  ==>  (M:1) doctor, (M:1) clinic (NULL = video / any)
CREATE TABLE prescription_templates (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doctor_id          BIGINT UNSIGNED NOT NULL,
    clinic_id          BIGINT UNSIGNED NULL,
    name               VARCHAR(120)    NOT NULL,
    is_default         BOOLEAN         NOT NULL DEFAULT FALSE,
    is_active          BOOLEAN         NOT NULL DEFAULT TRUE,

    -- ── branding assets (URLs; keys recovered via upload.service.keyFromUrl) ──
    logo_url           VARCHAR(500) NULL,
    watermark_url      VARCHAR(500) NULL,
    signature_url      VARCHAR(500) NULL,
    watermark_opacity  DECIMAL(3,2) NOT NULL DEFAULT 0.08,

    -- ── theme ────────────────────────────────────────────────────────────────
    header_bg_color    CHAR(7)  NOT NULL DEFAULT '#7EE0EF',
    header_text_color  CHAR(7)  NOT NULL DEFAULT '#12263F',
    footer_bg_color    CHAR(7)  NOT NULL DEFAULT '#2E4A2E',
    footer_text_color  CHAR(7)  NOT NULL DEFAULT '#FFFFFF',
    accent_color       CHAR(7)  NOT NULL DEFAULT '#12263F',
    font_family        VARCHAR(60)  NOT NULL DEFAULT 'Helvetica, Arial, sans-serif',
    base_font_size_pt  DECIMAL(3,1) NOT NULL DEFAULT 10.0,

    -- ── page ─────────────────────────────────────────────────────────────────
    page_size          ENUM('A4','Letter') NOT NULL DEFAULT 'A4',
    margin_mm_top      SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_right    SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_bottom   SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    margin_mm_left     SMALLINT UNSIGNED NOT NULL DEFAULT 8,

    -- ── zone toggles ─────────────────────────────────────────────────────────
    show_header        BOOLEAN NOT NULL DEFAULT TRUE,
    show_footer        BOOLEAN NOT NULL DEFAULT TRUE,
    show_sidebar       BOOLEAN NOT NULL DEFAULT TRUE,
    show_watermark     BOOLEAN NOT NULL DEFAULT TRUE,
    sidebar_width_pct  TINYINT UNSIGNED NOT NULL DEFAULT 18,

    -- ── content (validated JSON; see backend-plan §5, integration-plan §2) ────
    header_json         JSON NOT NULL,
    patient_fields_json JSON NOT NULL,
    sidebar_json        JSON NOT NULL,
    body_json           JSON NOT NULL,
    footer_json         JSON NOT NULL,

    rx_number_prefix   VARCHAR(10) NULL,          -- e.g. 'OSC'
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_rxtpl_doctor FOREIGN KEY (doctor_id)
        REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rxtpl_clinic FOREIGN KEY (clinic_id)
        REFERENCES clinics(id) ON DELETE SET NULL,
    UNIQUE KEY uq_rxtpl_name (doctor_id, clinic_id, name),
    KEY idx_rxtpl_doctor_active (doctor_id, is_active)
) ENGINE=InnoDB;

-- 2. PRESCRIPTIONS  ==>  (1:1) booking (nullable for future walk-ins)
CREATE TABLE prescriptions (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id            BIGINT UNSIGNED NULL,      -- NULL = walk-in (out of scope; column reserved)
    doctor_id             BIGINT UNSIGNED NOT NULL,
    patient_id            BIGINT UNSIGNED NOT NULL,
    clinic_id             BIGINT UNSIGNED NULL,
    template_id           BIGINT UNSIGNED NULL,      -- SET NULL on template delete; snapshot survives

    status                ENUM('draft','finalized') NOT NULL DEFAULT 'draft',
    rx_number             VARCHAR(40) NULL,          -- stamped at finalize
    version               SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    parent_prescription_id BIGINT UNSIGNED NULL,     -- set on an amendment
    superseded_by_id      BIGINT UNSIGNED NULL,      -- set on the amended original
    amend_reason          VARCHAR(255) NULL,

    -- ── clinical content ─────────────────────────────────────────────────────
    chief_complaint  VARCHAR(500) NULL,
    height_cm        DECIMAL(5,2) NULL,
    weight_kg        DECIMAL(5,2) NULL,
    blood_pressure   VARCHAR(20)  NULL,
    pulse_rate_bpm   SMALLINT UNSIGNED NULL,
    temperature_f    DECIMAL(4,1) NULL,
    spo2_percent     TINYINT UNSIGNED NULL,
    diagnosis        VARCHAR(500) NULL,
    notes            TEXT NULL,
    advice           TEXT NULL,               -- free-text advice
    advice_selected  JSON NULL,               -- string[] ticked from the sidebar menu
    follow_up_date   DATE NULL,

    -- ── the freeze (README §4) ───────────────────────────────────────────────
    template_snapshot JSON NULL,              -- NOT NULL in practice once finalized
    pdf_url           VARCHAR(500) NULL,
    finalized_at      DATETIME NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_rx_booking  FOREIGN KEY (booking_id)  REFERENCES bookings(id) ON DELETE CASCADE,
    CONSTRAINT fk_rx_doctor   FOREIGN KEY (doctor_id)   REFERENCES doctor_profiles(user_id),
    CONSTRAINT fk_rx_patient  FOREIGN KEY (patient_id)  REFERENCES users(id),
    CONSTRAINT fk_rx_clinic   FOREIGN KEY (clinic_id)   REFERENCES clinics(id) ON DELETE SET NULL,
    CONSTRAINT fk_rx_template FOREIGN KEY (template_id) REFERENCES prescription_templates(id) ON DELETE SET NULL,
    CONSTRAINT fk_rx_parent   FOREIGN KEY (parent_prescription_id) REFERENCES prescriptions(id),

    UNIQUE KEY uq_rx_booking_version (booking_id, version),  -- 1:1 per version; NULLs don't collide
    UNIQUE KEY uq_rx_number (rx_number),
    KEY idx_rx_doctor (doctor_id, status),
    KEY idx_rx_patient (patient_id, status)
) ENGINE=InnoDB;

-- 3. PRESCRIPTION ITEMS  ==>  (1:M) prescription -> medicine rows
CREATE TABLE prescription_items (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prescription_id BIGINT UNSIGNED NOT NULL,
    sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    medicine_name   VARCHAR(200) NOT NULL,
    dosage          VARCHAR(100) NULL,
    route           ENUM('oral','topical','injection','drops','inhaler','other') NOT NULL DEFAULT 'oral',
    frequency       VARCHAR(100) NULL,
    timing          ENUM('before_food','after_food','with_food','anytime') NULL DEFAULT 'after_food',
    duration_days   SMALLINT UNSIGNED NULL,
    notes           VARCHAR(255) NULL,

    CONSTRAINT fk_rxitem_prescription FOREIGN KEY (prescription_id)
        REFERENCES prescriptions(id) ON DELETE CASCADE,
    KEY idx_rxitem_rx (prescription_id, sort_order)
) ENGINE=InnoDB;
```

### 3.1 Four schema choices worth defending

- **`UNIQUE (booking_id, version)` instead of `UNIQUE (booking_id)`.** `dbstruct.md §14` proposed the latter. It makes **amendment impossible** — the amended copy has the same `booking_id`. Including `version` keeps "one live Rx per booking" (the app enforces it: you may only amend the newest) while letting the audit trail exist. MySQL's `UNIQUE` ignores NULL `booking_id`, so future walk-ins slot in free.
- **`UNIQUE (doctor_id, rx_number)`, not `UNIQUE (rx_number)`.** The sequence in `rx_counters` is per-doctor, and the prefix comes from the doctor's own template. A global unique index means the second doctor who picks the prefix `OSC` gets a `500` on their first finalize of the year, because `OSC-2026-000001` is already taken by someone else's practice. Scope the index to the thing that scopes the sequence.
- **`template_id` is `ON DELETE SET NULL`, `template_snapshot` is the truth.** Deleting a letterhead must never corrupt a signed prescription. The FK exists only so the editor can say "3 prescriptions used this".
- **`parent_prescription_id` is `ON DELETE SET NULL`, not `RESTRICT`.** Deleting a booking cascades to *both* versions of its prescription, and MySQL does not order a cascade. Under `RESTRICT` the delete aborts or succeeds depending on which row the engine reaches first — a coin flip. `SET NULL` makes it deterministic.
- **No generated `default_key` column.** The booking plan's `active_lock_key` trick guards a *cross-user* race (two patients, one slot). "Exactly one default template" is a *single-user* invariant on the doctor's own settings page; a transaction (`§4.2`) is sufficient and far cheaper than the `ensureBookingLockKey.js` machinery MySQL forced on us there.

### 3.2 How the migration lands on an existing database

`db/migrate.js` applies `docs/dbstruct.md` first, as `000_base_schema`. That file already creates `prescriptions` and `prescription_items` — the sketch from §14–15. So migration `006` opens with `DROP TABLE IF EXISTS` on both and recreates them. That is safe precisely once: no code has ever written a row to them, because the feature did not exist. It also means a **fresh** database and an **existing** one converge on the same shape, without a dozen `information_schema`-guarded `ALTER`s.

`rx_counters` has no Sequelize model (raw-SQL upsert only), so `sequelize.sync()` skips it in dev. `db/ensureRxCounters.js` creates it after sync, mirroring `ensureBookingLockKey.js`.

`docs/dbstruct.md §14–15` keeps the old sketch, with a comment pointing here — rewriting it would make `000_base_schema` create the new tables and then `006` would drop and recreate them for no reason.

---

## 4. Models & services

### 4.1 Models

Three Sequelize models mirroring the tables. Notes:

- `prescriptionTemplate.model.js` — declare the five JSON columns as `DataTypes.JSON`. Sequelize parses/serializes them; **do not** hand-stringify.
- `prescription.model.js` — `tableName: "prescriptions"`, `timestamps: true`. `templateSnapshot: DataTypes.JSON`.
- `prescriptionItem.model.js` — `timestamps: false` (the table has no timestamps), matching `clinic.model.js`'s precedent.

Associations in `models/index.js`:

```js
DoctorProfile.hasMany(PrescriptionTemplate, { as: "prescriptionTemplates", foreignKey: "doctorId" });
Clinic.hasMany(PrescriptionTemplate,       { as: "prescriptionTemplates", foreignKey: "clinicId" });

Booking.hasOne(Prescription,   { as: "prescription", foreignKey: "bookingId" });
Prescription.belongsTo(Booking,{ as: "booking",      foreignKey: "bookingId" });
Prescription.belongsTo(DoctorProfile, { as: "doctor",  foreignKey: "doctorId" });
Prescription.belongsTo(User,          { as: "patient", foreignKey: "patientId" });
Prescription.belongsTo(Clinic,        { as: "clinic",  foreignKey: "clinicId" });
Prescription.belongsTo(PrescriptionTemplate, { as: "template", foreignKey: "templateId" });
Prescription.hasMany(PrescriptionItem, { as: "items", foreignKey: "prescriptionId", onDelete: "CASCADE" });
Prescription.belongsTo(Prescription,   { as: "parent", foreignKey: "parentPrescriptionId" });
```

### 4.2 `prescriptionTemplate.service.js`

```
list(doctorId)                         → active templates, newest first
getOne(doctorId, id)                   → 404 TEMPLATE_NOT_FOUND if not owned
create(doctorId, dto)                  → first template for a doctor is forced isDefault
update(doctorId, id, dto)              → deep-merges only the JSON keys present
setDefault(doctorId, id)               → TRANSACTION: clear all, set one
duplicate(doctorId, id, { name, clinicId })
remove(doctorId, id)                   → soft: is_active=false; 409 TEMPLATE_IN_USE if last active
putAsset(doctorId, id, kind, file)     → upload.service.put → remove old via keyFromUrl
removeAsset(doctorId, id, kind)
resolveTemplate(doctorId, { clinicId, templateId })   → README §3 order, incl. auto-provision
buildDefaultTemplate(doctorId)         → seeds from the doctor's own profile + clinic
```

`setDefault` is the only place a transaction is genuinely needed:

```js
await sequelize.transaction(async (t) => {
  await PrescriptionTemplate.update(
    { isDefault: false },
    { where: { doctorId, isDefault: true }, transaction: t }
  );
  const [n] = await PrescriptionTemplate.update(
    { isDefault: true },
    { where: { id, doctorId, isActive: true }, transaction: t }
  );
  if (!n) throw new ApiError(404, "Template not found", { code: ERROR_CODES.TEMPLATE_NOT_FOUND });
});
```

Note the ownership predicate lives **in the `where` clause**, not in a preceding `SELECT`. Same discipline as `booking.service`: never check-then-write.

**`buildDefaultTemplate` is the doctor's first-run experience.** It reads `users.name`, `doctor_profiles.qualification | headline | registrationNumber | publicPhone | publicEmail`, and the clinic's `name | addressLine | city | pincode | phone`, and produces a template that already looks like the doctor's letterhead. One eager-loaded query, no loops.

### 4.3 `prescription.service.js`

```
createDraft(doctorId, { bookingId, templateId })
  1. Load booking WHERE id AND doctorId          → 404 NOT_FOUND
  2. status ∈ {confirmed, completed}             → 422 RX_BOOKING_NOT_ELIGIBLE
  3. Existing non-superseded Rx for booking?     → 409 RX_ALREADY_EXISTS
  4. resolveTemplate(doctorId, { clinicId: booking.clinicId, templateId })
  5. INSERT prescriptions {status:'draft', patientId: booking.patientId, ...}

getOne(doctorId, id)      → include items (ordered by sortOrder) + template
patch(doctorId, id, dto)  → 409 RX_NOT_EDITABLE unless status==='draft'
                            items[] is REPLACE-THE-SET, in ONE transaction:
                              destroy where prescriptionId; bulkCreate(items with sortOrder=index)
                            (bulkCreate, never a create() per row — see backend-conventions)

finalize(doctorId, id, { emailPatient })
  IDEMPOTENT: if already finalized → return it unchanged (no re-render, no second email)
  TRANSACTION:
    rxNumber        = await nextRxNumber(doctorId, template.rxNumberPrefix)
    templateSnapshot= snapshotOf(resolvedTemplate)     // plain JSON, assets as absolute URLs
    status='finalized', finalizedAt=now
  AFTER COMMIT (never inside the transaction — see §7.4):
    buffer = await pdf.render(templateSnapshot, rxView)
    { url } = await upload.put(buffer, { keyPrefix: `prescriptions/${doctorId}`, ... })
    await rx.update({ pdfUrl: url })
    if (emailPatient) mail.sendPrescriptionReady(...)   // fire-and-log, never blocks the response

amend(doctorId, id, { reason })
  TRANSACTION: original.supersededById = new.id; new = copy(original, {status:'draft',
     version: n+1, parentPrescriptionId: id, rxNumber: null, pdfUrl: null, finalizedAt: null})
  Items are deep-copied so the doctor edits a filled form, not a blank one.

remove(doctorId, id)             → draft only
listForDoctor(doctorId, filters)
listForPatient(patientId)        → WHERE status='finalized' — drafts NEVER leak
getPdf(id, actorScope)           → stream stored object; render-on-demand only if pdfUrl is null
```

**`nextRxNumber`** (`utils/rxNumber.js`): `PREFIX-YYYY-NNNNNN`, sequence scoped per doctor per year. Implement as `SELECT COUNT(*) … FOR UPDATE` inside the finalize transaction, or a small `rx_counters(doctor_id, year, next_val)` table with `INSERT … ON DUPLICATE KEY UPDATE next_val = LAST_INSERT_ID(next_val + 1)`. **Prefer the counter table** — a `COUNT(*)` gap-fills after a deleted draft and can collide. The `UNIQUE (rx_number)` index is the backstop either way.

---

## 5. Validators (`prescription.validator.js`)

Joi, per `backend-conventions`. The JSON blobs get **real schemas** — this is a security boundary, not paperwork.

```js
const HEX = Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/);
const SAFE = (max) => Joi.string().trim().max(max);   // no HTML permitted; escaped at render anyway

const headerJson = Joi.object({
  doctorNameLine:  SAFE(120).required(),
  credentialLines: Joi.array().items(SAFE(160)).max(10).default([]),
  clinicName:      SAFE(120).allow(""),
  clinicTagline:   SAFE(160).allow(""),
  regNoLabel:      SAFE(40).default("Regd. No."),
  regNoValue:      SAFE(60).allow(""),
  logoPosition:    Joi.string().valid("left", "right").default("right"),
});

const patientFieldsJson = Joi.array().max(12).items(
  Joi.object({
    key:     Joi.string().valid(...PRESCRIPTION_PATIENT_FIELDS).required(),
    label:   SAFE(40).required(),
    enabled: Joi.boolean().default(true),
    row:     Joi.number().integer().min(1).max(3).default(1),
  })
).unique("key");

const sidebarJson = Joi.object({
  title:  SAFE(60).default("Advice"),
  groups: Joi.array().max(6).items(Joi.object({
    title: SAFE(60).allow(""),
    items: Joi.array().items(SAFE(80)).max(60).required(),
  })).required(),
});

const footerJson = Joi.object({
  columns: Joi.array().min(1).max(4).items(Joi.object({
    title: SAFE(40).allow(""),
    lines: Joi.array().items(SAFE(120)).max(6).required(),
  })).required(),
});

const bodyJson = Joi.object({
  rxSymbol:        Joi.boolean().default(true),
  showDiagnosis:   Joi.boolean().default(true),
  showVitals:      Joi.boolean().default(true),
  medicineColumns: Joi.array().items(
    Joi.string().valid("medicineName","dosage","route","frequency","timing","durationDays","notes")
  ).min(1).default(["medicineName","dosage","frequency","timing","durationDays"]),
  showAdviceText:  Joi.boolean().default(true),
  showFollowUp:    Joi.boolean().default(true),
  disclaimer:      SAFE(300).allow(""),
});
```

Exported schemas: `createTemplate`, `updateTemplate` (every key `.optional()`, `min(1)` on the object), `uploadAsset` (`kind: valid('logo','watermark','signature')`), `createPrescription`, `updatePrescription` (vitals with real bounds: `pulseRateBpm` 20–300, `spo2Percent` 50–100, `temperatureF` 90–110), `finalizePrescription`, `amendPrescription`, `listPrescriptions`.

`updatePrescription.items` is `Joi.array().max(30).items(itemSchema)` — an unbounded array of medicines is an unbounded PDF.

Note the asset endpoints must narrow the mime allowlist: `middlewares/upload.js` permits `application/pdf` (needed for the doctor's degree certificates). A **PDF logo is nonsense and a renderer hazard.** The asset controller rejects anything but `image/png` / `image/jpeg` before calling `upload.put`.

---

## 6. Controllers & routes

Controllers stay thin — parse `req`, call the service, `sendSuccess(res, data, message)`. No business logic, no Sequelize.

`routes/doctorPrescription.routes.js`:

```js
const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

// ── templates ────────────────────────────────────────────────────────────────
router.get   ("/prescription-templates",            ...guard, tpl.list);
router.post  ("/prescription-templates",            ...guard, validate(s.createTemplate), tpl.create);
router.get   ("/prescription-templates/:id",        ...guard, tpl.getOne);
router.patch ("/prescription-templates/:id",        ...guard, validate(s.updateTemplate), tpl.update);
router.delete("/prescription-templates/:id",        ...guard, tpl.remove);
router.post  ("/prescription-templates/:id/default",   ...guard, tpl.setDefault);
router.post  ("/prescription-templates/:id/duplicate", ...guard, validate(s.duplicateTemplate), tpl.duplicate);
router.post  ("/prescription-templates/:id/assets",    ...guard, upload.single("file"), validate(s.uploadAsset), tpl.putAsset);
router.delete("/prescription-templates/:id/assets/:kind", ...guard, tpl.removeAsset);
router.get   ("/prescription-templates/:id/preview.pdf", ...guard, tpl.previewPdf);

// ── prescriptions ────────────────────────────────────────────────────────────
router.get   ("/prescriptions",              ...guard, validate(s.listPrescriptions), rx.list);
router.post  ("/prescriptions",              ...guard, validate(s.createPrescription), rx.create);
router.get   ("/prescriptions/:id",          ...guard, rx.getOne);
router.patch ("/prescriptions/:id",          ...guard, validate(s.updatePrescription), rx.update);
router.delete("/prescriptions/:id",          ...guard, rx.remove);
router.post  ("/prescriptions/:id/finalize", ...guard, validate(s.finalizePrescription), rx.finalize);
router.post  ("/prescriptions/:id/amend",    ...guard, validate(s.amendPrescription), rx.amend);
router.get   ("/prescriptions/:id/pdf",      ...guard, rx.pdf);

// convenience read used by the appointment screen
router.get   ("/bookings/:id/prescription",  ...guard, rx.byBooking);
```

Mount in `routes/index.js` next to `doctorBooking.routes.js`. `/patient/prescriptions` (3 read routes) extends `patient.routes.js` behind `authorize(ROLES.PATIENT)`.

**Rate-limit `preview.pdf` and `finalize`.** Each spawns a Chromium page render. Add a `pdfLimiter` to `middlewares/rateLimiters.js` (e.g. 20/min/user) — without it, one held-down "Preview" button is a self-inflicted DoS.

---

## 7. `prescriptionPdf.service.js` — the renderer

The **only** file in the codebase that knows a browser exists. Its public surface is two functions:

```js
module.exports = {
  render(snapshot, rx),        // → Promise<Buffer>
  renderSample(snapshot),      // → Promise<Buffer>   (preview, fake patient)
  shutdown(),                  // called from server.js on SIGTERM
};
```

### 7.1 Snapshot → HTML

`templates/prescriptions/rx.html` is a full A4 document with CSS custom properties for every themeable value:

```html
<style>
  @page { size: A4; margin: 0; }
  :root {
    --header-bg:   {{headerBgColor}};
    --footer-bg:   {{footerBgColor}};
    --accent:      {{accentColor}};
    --wm-opacity:  {{watermarkOpacity}};
    --font:        {{fontFamily}};
    --base:        {{baseFontSizePt}}pt;
  }
  .watermark {
    position: fixed; inset: 0; margin: auto;
    background: url("{{watermarkDataUri}}") center/60% no-repeat;
    opacity: var(--wm-opacity); z-index: 0;
  }
  .sidebar { width: {{sidebarWidthPct}}%; border-right: 1px solid var(--accent); }
</style>
```

The repeating parts (`credentialLines`, sidebar `items`, footer `columns`) can't be done by `mail.service`'s `{{key}}` regex. Add a **~60-line builder** in the service that composes the HTML string from the snapshot. Two hard rules:

1. **Escape every doctor- and patient-supplied string** through one `esc()` helper before it touches the HTML. The doctor's `credentialLines` are attacker-controlled with respect to the patient who opens the PDF. Joi caps their length; `esc()` makes them inert.
2. **Inline the assets as `data:` URIs.** Chromium is fetching `logo_url` over the network otherwise — slow, flaky, and in a private-S3 world, broken. Fetch the bytes once (`upload.service` already knows the key) and base64 them in. Cache per snapshot.

### 7.2 Puppeteer

```js
const puppeteer = require("puppeteer");
let browserPromise = null;

// One browser for the process; a fresh PAGE per render. Launching Chromium per
// request costs ~800ms and leaks under load.
function browser() {
  browserPromise ||= puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"], // required in most containers
  });
  return browserPromise;
}

async function toPdf(html, { pageSize, margins }) {
  const page = await (await browser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: env.PDF_TIMEOUT_MS });
    return await page.pdf({
      format: pageSize,
      printBackground: true,          // without this the coloured bars vanish
      margin: { top: `${margins.top}mm`, /* … */ },
      displayHeaderFooter: false,     // the letterhead is in-flow; see §7.3
    });
  } finally {
    await page.close();               // ALWAYS — a leaked page is a leaked tab
  }
}
```

### 7.3 The multi-page question

Puppeteer's `displayHeaderFooter` + `headerTemplate` repeats a header on every page, but that HTML runs in a **separate, style-less context** (no `<style>` inheritance, no external CSS) — reproducing the coloured credential block there is painful.

Decision: the letterhead is **in-flow on page 1 only**, and pages 2+ get a slim repeating strip via `headerTemplate` (doctor name + `rx_number` + `Page X of Y`). A prescription that overflows A4 is rare; a 60-item sidebar plus 30 medicines is the worst case and it degrades gracefully. Put `.sidebar { break-inside: avoid; }` and `thead { display: table-header-group; }` so the medicine table repeats its header.

### 7.4 Failure handling — the rule that matters

**Never render a PDF inside the finalize transaction.** Chromium takes 300–1500 ms; holding a row lock across it under any concurrency is a deadlock generator, and a Chromium crash would roll back a clinically-completed prescription.

So finalize commits first, then renders. Which means `pdf_url` can legitimately be `NULL` on a `finalized` row when Chromium falls over. That is not corruption — the record is signed and the snapshot is frozen, so the PDF is **reproducible at any time**. `GET /prescriptions/:id/pdf` therefore reads:

```js
if (rx.status !== "finalized") throw new ApiError(409, …, { code: ERROR_CODES.RX_NOT_EDITABLE });
if (!rx.pdfUrl) {                                   // a prior render failed — heal on read
  const buf = await pdf.render(rx.templateSnapshot, view(rx));
  const { url } = await upload.put(buf, { … });
  await rx.update({ pdfUrl: url });
}
return redirectOrStream(rx.pdfUrl);
```

Self-healing, idempotent, and it makes a transient Chromium failure invisible to the doctor. Log the original failure at `error` so it's still visible in ops.

---

## 8. Env & constants

`config/env.js` (all with defaults so local dev needs no new `.env` keys):

| Var | Default | Purpose |
|---|---|---|
| `PDF_ENGINE` | `puppeteer` | The seam. `none` disables rendering (CI/test). |
| `PDF_TIMEOUT_MS` | `15000` | Per-render cap. |
| `PDF_MAX_CONCURRENCY` | `2` | Simple semaphore around `toPdf`; Chromium pages are memory-hungry. |
| `PUPPETEER_EXECUTABLE_PATH` | *(unset)* | Point at a system Chromium in slim images. |
| `RX_NUMBER_PREFIX` | `RX` | Fallback when a template sets none. |

`config/constants.js` additions:

```js
const PRESCRIPTION_STATUS   = Object.freeze({ DRAFT: "draft", FINALIZED: "finalized" });
const MEDICINE_ROUTES       = Object.freeze(["oral","topical","injection","drops","inhaler","other"]);
const MEDICINE_TIMINGS      = Object.freeze(["before_food","after_food","with_food","anytime"]);
const TEMPLATE_ASSET_KINDS  = Object.freeze(["logo","watermark","signature"]);
const PRESCRIPTION_PATIENT_FIELDS = Object.freeze([
  "name","age","sex","phone","address","bp","pulse","weight","height","temperature","spo2","date",
]);
// + ERROR_CODES: TEMPLATE_NOT_FOUND, TEMPLATE_IN_USE, RX_ALREADY_EXISTS,
//                RX_NOT_EDITABLE, RX_BOOKING_NOT_ELIGIBLE, PDF_RENDER_FAILED
```

`PRESCRIPTION_PATIENT_FIELDS` is the frozen list both the Joi validator and the frontend field-picker read — the same "one list, no drift" discipline as `ONBOARDING_REQUIRED_STEPS` and `PATIENT_REQUIRED_FIELDS`.

---

## 9. Serializers

Add to `utils/serializers.js`:

- `serializeTemplate(t)` — camelCase, JSON columns passed through, `assets: { logoUrl, watermarkUrl, signatureUrl }` grouped.
- `serializeTemplateSummary(t)` — for the list: `id, name, clinic: {id,name} | null, isDefault, updatedAt`.
- `serializePrescriptionForDoctor(rx)` — `+ items[]`, `+ template` (live) or `+ snapshot` (finalized), `+ canEdit: status==='draft'`, `+ pdfUrl`.
- `serializePrescriptionForPatient(rx)` — **no `notes`** if you decide internal notes are doctor-only (§10 Q1); `+ doctor: { name, qualification }`, `+ clinic`, `+ pdfUrl`.

---

## 10. Test checklist (before calling the backend done)

1. Two concurrent `POST /prescriptions` for the same booking → exactly one 201, one 409 `RX_ALREADY_EXISTS`.
2. `PATCH` a finalized Rx → 409 `RX_NOT_EDITABLE`. `PATCH` another doctor's draft → 404 (not 403 — don't confirm existence).
3. `finalize` twice → same `rx_number`, same `pdf_url`, exactly one e-mail sent.
4. Finalize, then change the template's logo, then `GET …/pdf` → **the old logo**. This is the single most important test in the file.
5. `PATCH` items `[A,B,C]` → `[C,A]` → exactly two rows, `sort_order` 0,1.
6. Kill Chromium mid-finalize → row is `finalized` with `pdf_url = NULL`; a subsequent `GET …/pdf` heals it.
7. `GET /patient/prescriptions` never returns a `draft`.
8. Upload a `.pdf` as a logo → 422 `UNSUPPORTED_FILE_TYPE`.
9. `credentialLines: ["<img src=x onerror=alert(1)>"]` → renders as literal text in the PDF.
10. Delete the last active template → 409 `TEMPLATE_IN_USE`; delete a used-but-not-last one → old prescriptions still render.
