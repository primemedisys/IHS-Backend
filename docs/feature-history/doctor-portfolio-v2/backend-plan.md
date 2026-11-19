# Backend — Doctor Portfolio v2

**Stack:** Node.js + **Express 5** + **Sequelize 6** + **mysql2**, CommonJS. Validation with **Joi**. Extends the doctor-onboarding + clinics features already under `backend/src/`. The layered flow is non-negotiable (`.claude/skills/backend-conventions`):

```
route → validate(joiSchema) → authenticate → authorize('doctor') → controller → service → model
```

Read `README.md` first. **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

The single biggest lever: **all 6 simple 1:M resources (education, experience, services, publications, memberships, faqs) share ONE generic owned-CRUD helper** in the service and ONE controller factory — we do not write 6× near-identical code (backend-conventions rule 9). Gallery adds an upload; insurances is a replace-the-set M:N like the existing `setLanguages`.

---

## 1. Migration — `src/db/migrations/004_doctor_portfolio_v2.sql` 🔵

Forward-only, idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`), applied by `npm run migrate` (tracked in `_migrations`). Copy the full column/table bodies **verbatim from `docs/dbstruct.md §6, §6f–6m`** so the hand-written schema stays the source of truth.

```sql
USE clinic_platform;

-- 5 new portfolio columns on the existing table (dbstruct.md §6)
ALTER TABLE doctor_profiles
  ADD COLUMN IF NOT EXISTS headline            VARCHAR(160)  NULL AFTER bio,
  ADD COLUMN IF NOT EXISTS gender              ENUM('male','female','other') NULL AFTER headline,
  ADD COLUMN IF NOT EXISTS practice_philosophy VARCHAR(1000) NULL AFTER gender,
  ADD COLUMN IF NOT EXISTS public_phone        VARCHAR(20)   NULL AFTER practice_philosophy,
  ADD COLUMN IF NOT EXISTS public_email        VARCHAR(190)  NULL AFTER public_phone;

-- 7 new 1:M tables (dbstruct.md §6f–6l) — copy full CREATE TABLE bodies
CREATE TABLE IF NOT EXISTS doctor_education    ( ... );   -- §6f
CREATE TABLE IF NOT EXISTS doctor_experience   ( ... );   -- §6g
CREATE TABLE IF NOT EXISTS doctor_services     ( ... );   -- §6h
CREATE TABLE IF NOT EXISTS doctor_publications ( ... );   -- §6i
CREATE TABLE IF NOT EXISTS doctor_memberships  ( ... );   -- §6j
CREATE TABLE IF NOT EXISTS doctor_gallery      ( ... );   -- §6k
CREATE TABLE IF NOT EXISTS doctor_faqs         ( ... );   -- §6l

-- M:N insurance (dbstruct.md §6m)
CREATE TABLE IF NOT EXISTS insurances        ( ... );
CREATE TABLE IF NOT EXISTS doctor_insurances ( ... );

-- seed insurers (guarded by UNIQUE uq_insurance_name, so re-running is safe)
INSERT IGNORE INTO insurances (name) VALUES
  ('Star Health'),('HDFC ERGO'),('ICICI Lombard'),('Niva Bupa'),
  ('LIC Health'),('CGHS'),('Ayushman Bharat (PM-JAY)'),('Self-pay / No insurance');
```

Verify: `DESCRIBE doctor_profiles;` shows the 5 new columns; `SHOW TABLES;` shows the 9 new tables; run twice → no error.

---

## 2. Models 🔵 (+ 🟡 `doctorProfile.model.js`, 🟡 `models/index.js`)

One model per table, registered through `models/index.js`. Match the `doctorAward.model.js` style (`timestamps: false`, camelCase field → snake_case column via Sequelize's `underscored`-free explicit naming — here field names map 1:1 because the codebase defines camelCase attributes on snake_case tables through `tableName` + attribute keys; confirm against `doctorAward.model.js`).

**🟡 `models/doctorProfile.model.js`** — add the 5 attributes:

```js
headline:           { type: DataTypes.STRING(160),  allowNull: true },
gender:             { type: DataTypes.ENUM("male", "female", "other"), allowNull: true },
practicePhilosophy: { type: DataTypes.STRING(1000), allowNull: true, field: "practice_philosophy" },
publicPhone:        { type: DataTypes.STRING(20),   allowNull: true, field: "public_phone" },
publicEmail:        { type: DataTypes.STRING(190),  allowNull: true, field: "public_email" },
```

> Note: existing columns in this model use camelCase attribute names that already differ from snake_case columns (e.g. `experienceYears`). Sequelize is mapping via explicit `field:` or a global `define.underscored`. **Check how `registrationNumber`/`experienceYears` map today and follow the identical mechanism** for the 5 new ones (add `field:` only if the existing ones do).

**🔵 New model files** (each mirrors `doctorAward.model.js`):

| File | Table | Attributes (besides `id`, `doctorId`) |
|---|---|---|
| `doctorEducation.model.js` | `doctor_education` | `degree, institution, fieldOfStudy, yearFrom, yearTo, displayOrder` |
| `doctorExperience.model.js` | `doctor_experience` | `organization, roleTitle, startYear, endYear, isCurrent, description, displayOrder` |
| `doctorService.model.js` | `doctor_services` | `name, description, displayOrder` |
| `doctorPublication.model.js` | `doctor_publications` | `title, publisher, year, url, displayOrder` |
| `doctorMembership.model.js` | `doctor_memberships` | `organization, roleTitle, sinceYear, displayOrder` |
| `doctorGallery.model.js` | `doctor_gallery` | `imageUrl, caption, displayOrder` |
| `doctorFaq.model.js` | `doctor_faqs` | `question, answer, displayOrder` |
| `insurance.model.js` | `insurances` | `id, name` |
| `doctorInsurance.model.js` | `doctor_insurances` | junction (composite PK `doctorId, insuranceId`) |

Example (`doctorEducation.model.js`):

```js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DoctorEducation = sequelize.define(
  "DoctorEducation",
  {
    id:            { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId:      { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: "doctor_id" },
    degree:        { type: DataTypes.STRING(150), allowNull: false },
    institution:   { type: DataTypes.STRING(200), allowNull: false },
    fieldOfStudy:  { type: DataTypes.STRING(150), allowNull: true, field: "field_of_study" },
    yearFrom:      { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, field: "year_from" },
    yearTo:        { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, field: "year_to" },
    displayOrder:  { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0, field: "display_order" },
  },
  { tableName: "doctor_education", timestamps: false }
);
module.exports = DoctorEducation;
```

**🟡 `models/index.js` — associations** (all doctor FKs → `DoctorProfile` PK `userId`):

```js
const has = (Model, as) =>
  DoctorProfile.hasMany(Model, { foreignKey: "doctorId", as, onDelete: "CASCADE" });

has(DoctorEducation,   "education");
has(DoctorExperience,  "experience");
has(DoctorService,     "services");
has(DoctorPublication, "publications");
has(DoctorMembership,  "memberships");
has(DoctorGallery,     "gallery");
has(DoctorFaq,         "faqs");

// M:N insurance (mirror the languages junction)
DoctorProfile.belongsToMany(Insurance, {
  through: DoctorInsurance, foreignKey: "doctorId", otherKey: "insuranceId", as: "insurances",
});
Insurance.belongsToMany(DoctorProfile, {
  through: DoctorInsurance, foreignKey: "insuranceId", otherKey: "doctorId", as: "doctors",
});
```

Export every new model + junction from `models/index.js`.

---

## 3. Validators — `validators/doctor.validator.js` 🟡 (Joi)

Extend `updateProfile` and add one schema per new writable resource. Enums come from `config/constants.js` (add `GENDERS`).

```js
const { GENDERS } = require("../config/constants");

// 🟡 extend the existing updateProfile
const updateProfile = Joi.object({
  qualification:      Joi.string().trim().max(255),
  registrationNumber: Joi.string().trim().max(100),
  experienceYears:    Joi.number().integer().min(0).max(80),
  bio:                Joi.string().trim().max(5000).allow("", null),
  onlineFee:          Joi.number().min(0).allow(null),
  // ── v2 hero / about / contact ──
  headline:           Joi.string().trim().max(160).allow("", null),
  gender:             Joi.string().valid(...GENDERS),
  practicePhilosophy: Joi.string().trim().max(1000).allow("", null),
  publicPhone:        Joi.string().trim().max(20).allow("", null),
  publicEmail:        Joi.string().trim().email().max(190).allow("", null),
}).min(1);

const YEAR = () => Joi.number().integer().min(1950).max(2100);

const createEducation = Joi.object({
  degree:       Joi.string().trim().max(150).required(),
  institution:  Joi.string().trim().max(200).required(),
  fieldOfStudy: Joi.string().trim().max(150).allow("", null),
  yearFrom:     YEAR(), yearTo: YEAR(),
});
const createExperience = Joi.object({
  organization: Joi.string().trim().max(200).required(),
  roleTitle:    Joi.string().trim().max(150).required(),
  startYear:    YEAR().required(),
  endYear:      YEAR().allow(null),
  isCurrent:    Joi.boolean().default(false),
  description:  Joi.string().trim().max(500).allow("", null),
});
const createService     = Joi.object({ name: Joi.string().trim().max(150).required(), description: Joi.string().trim().max(500).allow("", null) });
const createPublication  = Joi.object({ title: Joi.string().trim().max(300).required(), publisher: Joi.string().trim().max(200).allow("", null), year: YEAR().allow(null), url: Joi.string().uri().max(300).allow("", null) });
const createMembership   = Joi.object({ organization: Joi.string().trim().max(200).required(), roleTitle: Joi.string().trim().max(150).allow("", null), sinceYear: YEAR().allow(null) });
const createFaq          = Joi.object({ question: Joi.string().trim().max(300).required(), answer: Joi.string().trim().max(1000).required() });
const uploadGallery      = Joi.object({ caption: Joi.string().trim().max(255).allow("", null) }); // file validated in multer
const setInsurances      = Joi.object({ insuranceIds: Joi.array().items(Joi.number().integer().positive()).max(20).unique().required() });
```

> `PATCH` (update) reuses the `create*` schemas but with every key optional — export a `partial()` variant: `updateEducation = createEducation.fork(Object.keys(createEducation.describe().keys), (s) => s.optional()).min(1)`, or simply declare `.min(1)` partial copies. Keep it DRY with a small `partialOf(schema)` helper in the validator file.

`config/constants.js` 🟡:
```js
const GENDERS = Object.freeze(["male", "female", "other"]);
// export it
```

---

## 4. Service — `services/doctor.service.js` 🟡

Add **one generic owned-CRUD helper** reused by all 6 simple resources, plus gallery (upload) and insurances (M:N). And add every new relation to `fullInclude` so one query hydrates the whole profile.

**🟡 `fullInclude`** — append:
```js
{ model: DoctorEducation,   as: "education" },
{ model: DoctorExperience,  as: "experience" },
{ model: DoctorService,     as: "services" },
{ model: DoctorPublication, as: "publications" },
{ model: DoctorMembership,  as: "memberships" },
{ model: DoctorGallery,     as: "gallery" },
{ model: DoctorFaq,         as: "faqs" },
{ model: Insurance,         as: "insurances", through: { attributes: [] } },
```

**🔵 The generic 1:M owned-CRUD helper** (ownership always scoped by `doctorId=userId`; ordered by `displayOrder` then `id`):

```js
// One helper for education/experience/services/publications/memberships/faqs.
const ownedList = (Model, userId) =>
  Model.findAll({ where: { doctorId: userId }, order: [["displayOrder", "ASC"], ["id", "ASC"]] });

const ownedAdd = (Model, userId, data) => Model.create({ doctorId: userId, ...data });

async function ownedUpdate(Model, userId, id, patch) {
  const [count] = await Model.update(patch, { where: { id, doctorId: userId } });
  if (!count) throw ApiError.notFound("Item not found");
  return Model.findOne({ where: { id, doctorId: userId } });
}
// removeOwnedRow(Model, userId, id) already exists — reuse it verbatim.
```

Expose a **registry** so the controller/routes reference resources by key (keeps everything table-driven, one place to add the next section):

```js
const OWNED_RESOURCES = {
  education:    DoctorEducation,
  experience:   DoctorExperience,
  services:     DoctorService,
  publications: DoctorPublication,
  memberships:  DoctorMembership,
  faqs:         DoctorFaq,
};
const listOwned   = (key, userId)        => ownedList(OWNED_RESOURCES[key], userId);
const addOwned    = (key, userId, data)  => ownedAdd(OWNED_RESOURCES[key], userId, data);
const updateOwned = (key, userId, id, p) => ownedUpdate(OWNED_RESOURCES[key], userId, id, p);
const removeOwned = (key, userId, id)    => removeOwnedRow(OWNED_RESOURCES[key], userId, id);
```

**🔵 Gallery** (upload, mirrors `addDocument`):
```js
const listGallery = (userId) =>
  DoctorGallery.findAll({ where: { doctorId: userId }, order: [["displayOrder", "ASC"], ["id", "ASC"]] });

async function addGalleryImage(userId, file, caption) {
  const { url } = await uploadService.put(file.buffer, {
    keyPrefix: `doctor/${userId}/gallery`, filename: file.originalname, mimetype: file.mimetype,
  });
  return DoctorGallery.create({ doctorId: userId, imageUrl: url, caption: caption ?? null });
}

async function removeGalleryImage(userId, id) {
  const img = await DoctorGallery.findOne({ where: { id, doctorId: userId } });
  if (!img) throw ApiError.notFound("Image not found");
  await img.destroy();
  await uploadService.remove(uploadService.keyFromUrl(img.imageUrl));
}
```

**🔵 Insurances** (replace-the-set M:N, a copy of `setLanguages`):
```js
async function setInsurances(userId, ids) {
  await assertAllExist(Insurance, ids, "insurances");
  await sequelize.transaction(async (tx) => {
    await DoctorInsurance.destroy({ where: { doctorId: userId }, transaction: tx });
    await DoctorInsurance.bulkCreate(ids.map((insuranceId) => ({ doctorId: userId, insuranceId })), { transaction: tx });
  });
  return getOwnProfile(userId);
}
const listInsurances = () => Insurance.findAll({ order: [["name", "ASC"]] });  // public lookup
```

Export all the new functions.

> **No N+1:** `ownedUpdate` does one `UPDATE` + one `findOne`; `setInsurances` is `destroy` + `bulkCreate` in a transaction; every read is `findAll`/`include`. No `await` in a loop anywhere.

---

## 5. Controllers — `controllers/doctor.controller.js` 🟡 (a factory)

Avoid 24 near-identical handlers with one factory. Add it to the existing controller file.

```js
const {
  serializeEducation, serializeExperience, serializeService,
  serializePublication, serializeMembership, serializeFaq, serializeGalleryImage,
} = require("../utils/serializers");

/** Build {list,add,update,remove} handlers for one generic owned resource. */
function ownedHandlers(key, serialize, label) {
  return {
    list:   asyncHandler(async (req, res) => ok(res, (await doctorService.listOwned(key, req.user.id)).map(serialize), label)),
    add:    asyncHandler(async (req, res) => created(res, serialize(await doctorService.addOwned(key, req.user.id, req.body)), `${label} added`)),
    update: asyncHandler(async (req, res) => ok(res, serialize(await doctorService.updateOwned(key, req.user.id, req.params.id, req.body)), `${label} updated`)),
    remove: asyncHandler(async (req, res) => { await doctorService.removeOwned(key, req.user.id, req.params.id); return ok(res, null, `${label} removed`); }),
  };
}

exports.education    = ownedHandlers("education",    serializeEducation,   "Education");
exports.experience   = ownedHandlers("experience",   serializeExperience,  "Experience");
exports.services     = ownedHandlers("services",     serializeService,     "Service");
exports.publications = ownedHandlers("publications", serializePublication, "Publication");
exports.memberships  = ownedHandlers("memberships",  serializeMembership,  "Membership");
exports.faqs         = ownedHandlers("faqs",         serializeFaq,         "FAQ");

// gallery (upload) + insurances (M:N) are explicit
exports.listGallery   = asyncHandler(async (req, res) => ok(res, (await doctorService.listGallery(req.user.id)).map(serializeGalleryImage), "Gallery"));
exports.addGallery    = asyncHandler(async (req, res) => created(res, serializeGalleryImage(await doctorService.addGalleryImage(req.user.id, req.file, req.body.caption)), "Image added"));
exports.removeGallery = asyncHandler(async (req, res) => { await doctorService.removeGalleryImage(req.user.id, req.params.id); return ok(res, null, "Image removed"); });
exports.setInsurances = asyncHandler(async (req, res) => ok(res, serializeDoctorProfile(await doctorService.setInsurances(req.user.id, req.body.insuranceIds)), "Insurances updated"));
```

Public lookup in `controllers/publicDoctor.controller.js` 🟡:
```js
exports.listInsurances = asyncHandler(async (req, res) => ok(res, (await doctorService.listInsurances()).map(serializeInsurance), "Insurances"));
```

---

## 6. Routes 🟡

**`routes/doctor.routes.js`** — one `route()` block per owned resource (table-driven):

```js
const OWNED = {
  education:    schema.createEducation,
  experience:   schema.createExperience,
  services:     schema.createService,
  publications: schema.createPublication,
  memberships:  schema.createMembership,
  faqs:         schema.createFaq,
};
for (const [key, createSchema] of Object.entries(OWNED)) {
  const h = doctor[key];
  router.route(`/${key}`).all(...guard).get(h.list).post(validate(createSchema), h.add);
  router.route(`/${key}/:id`).all(...guard).patch(validate(schema.partialOf(createSchema)), h.update).delete(h.remove);
}

// gallery (multipart) + insurances (M:N)
router.route("/gallery").all(...guard).get(doctor.listGallery)
  .post(upload.single("file"), validate(schema.uploadGallery), doctor.addGallery);
router.delete("/gallery/:id", ...guard, doctor.removeGallery);

router.put("/insurances", ...guard, validate(schema.setInsurances), doctor.setInsurances);
```

> Keep `upload.single("file")` **before** `validate(...)` for the gallery POST so `req.body.caption` (a multipart text field) exists when Joi runs — same rule as documents.

**`routes/doctorsPublic.routes.js`** 🟡 — add `router.get("/insurances", publicDoctor.listInsurances);`.

No change to `routes/index.js` (the `/doctor` and public routers are already mounted).

---

## 7. Serializers — `utils/serializers.js` 🟡

One mapper per resource (snake→camel, DECIMAL→Number, `id`→String). Then wire them into BOTH `serializeDoctorProfile` (own) and `serializePublicDoctor` (public).

```js
const serializeEducation = (e) => { const x = plain(e); return { id: String(x.id), degree: x.degree, institution: x.institution, fieldOfStudy: x.fieldOfStudy ?? null, yearFrom: x.yearFrom ?? null, yearTo: x.yearTo ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializeExperience = (e) => { const x = plain(e); return { id: String(x.id), organization: x.organization, roleTitle: x.roleTitle, startYear: x.startYear, endYear: x.endYear ?? null, isCurrent: Boolean(x.isCurrent), description: x.description ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializeService     = (s) => { const x = plain(s); return { id: String(x.id), name: x.name, description: x.description ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializePublication  = (p) => { const x = plain(p); return { id: String(x.id), title: x.title, publisher: x.publisher ?? null, year: x.year ?? null, url: x.url ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializeMembership   = (m) => { const x = plain(m); return { id: String(x.id), organization: x.organization, roleTitle: x.roleTitle ?? null, sinceYear: x.sinceYear ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializeGalleryImage = (g) => { const x = plain(g); return { id: String(x.id), imageUrl: x.imageUrl, caption: x.caption ?? null, displayOrder: x.displayOrder ?? 0 }; };
const serializeFaq          = (f) => { const x = plain(f); return { id: String(x.id), question: x.question, answer: x.answer, displayOrder: x.displayOrder ?? 0 }; };
const serializeInsurance    = (i) => { const x = plain(i); return { id: x.id, name: x.name }; };
```

**🟡 `serializeDoctorProfile`** — add the new profile scalars + arrays:
```js
headline: p.headline ?? null,
gender: p.gender ?? null,
practicePhilosophy: p.practicePhilosophy ?? null,
publicPhone: p.publicPhone ?? null,
publicEmail: p.publicEmail ?? null,
education:    (p.education    || []).map(serializeEducation),
experience:   (p.experience   || []).map(serializeExperience),
services:     (p.services     || []).map(serializeService),
publications: (p.publications || []).map(serializePublication),
memberships:  (p.memberships  || []).map(serializeMembership),
gallery:      (p.gallery      || []).map(serializeGalleryImage),
faqs:         (p.faqs         || []).map(serializeFaq),
insurances:   (p.insurances   || []).map(serializeInsurance),
```

**🟡 `serializePublicDoctor`** — the key fixes + enrichment:
```js
gender: p.gender ?? "male",           // was hardcoded "male" — now real, default only if unset
headline: p.headline ?? "",           // NEW hero tagline
about: p.bio ?? "",
practicePhilosophy: p.practicePhilosophy ?? "",
// structured education replaces the empty [] (map to the frontend EducationEntry shape)
education: (p.education || []).map((e) => { const x = plain(e); return { degree: x.degree, institution: x.institution, year: x.yearTo ?? x.yearFrom ?? 0 }; }),
experience:   (p.experience   || []).map(serializeExperience),
services:     (p.services     || []).map(serializeService),
publications: (p.publications || []).map(serializePublication),
memberships:  (p.memberships  || []).map(serializeMembership),
gallery:      (p.gallery      || []).map(serializeGalleryImage),
faqs:         (p.faqs         || []).map(serializeFaq),
insurances:   (p.insurances   || []).map((i) => plain(i).name),
publicPhone: p.publicPhone ?? (user.phone ?? null),
publicEmail: p.publicEmail ?? (user.email ?? null),
qualifications: p.qualification ? [p.qualification] : [],
```

> The public `education` maps to the existing frontend `EducationEntry { degree, institution, year }` so the current timeline component keeps working; the richer fields (`fieldOfStudy`, `yearFrom`) surface via the new sections. Ensure `serializePublicDoctor`'s `User` include carries `phone`/`email` (add to the `fullInclude` User attributes: `["id","name","email","phone","profilePhotoUrl"]`).

---

## 8. The submit gate — `services/verification.service.js` 🟡

The **only** behavioral change that makes the new sections mandatory. Extend the `portfolio` predicate in `computeChecklist`:

```js
const contactOk = Boolean((profile.publicPhone || profile.user?.phone) && (profile.publicEmail || profile.user?.email));
// ...
portfolio: Boolean(
  profile.headline &&
    profile.gender &&
    profile.bio &&
    profile.user && profile.user.profilePhotoUrl &&
    contactOk &&
    (profile.education   || []).length >= 1 &&
    (profile.services    || []).length >= 1 &&
    (profile.experience  || []).length >= 1
),
```

`ONBOARDING_REQUIRED_STEPS` is unchanged (`portfolio` already gated). `getOnboarding` + `submit` already re-use `computeChecklist`, so the checklist and the submit guard stay in lockstep automatically. `POST /doctor/submit` now 422s `ONBOARDING_INCOMPLETE` until the core sections exist.

> To flip the tier to "everything mandatory," `&&` more arrays here (publications/gallery/faqs/insurances). To relax, drop a clause. One function, no ripple.

---

## 9. Upload middleware & storage 🟢 (reuse)

Gallery uses the **existing** `middlewares/upload.js` (multer memory storage, mime allowlist incl. `image/png`/`image/jpeg`, size limit) and `services/upload.service.js` (`put`/`remove`/`keyFromUrl`). No new upload code — only a new `keyPrefix` (`doctor/<id>/gallery`). Confirm the allowlist includes the image mimetypes (it does for photo). Consider capping gallery at 12 images (README §7 Q3) — enforce in the service before `create`.

---

## 10. Swagger — `config/swagger.js` 🟡

Add OpenAPI entries for every new route under the existing `Doctor` and `Doctors (public)` tags. The 6 owned resources share a body schema pattern; document `/doctor/gallery` as `multipart/form-data` (like `/doctor/documents`) and `PUT /doctor/insurances` with the `insuranceIds[]` body. A route with no doc entry is incomplete.

---

## 11. Build order (backend)

1. 🔵 `004_doctor_portfolio_v2.sql` → `npm run migrate`; 🟡 `DoctorProfile` cols; 🔵 8 models + associations + exports.
2. 🟡 serializers (all 8) + wire into own/public shapes; 🟡 add `phone`/`email` to the User include.
3. 🟡 validators (extend `updateProfile`, add `create*` + `partialOf`, `GENDERS`).
4. 🟡 service (fullInclude, generic CRUD registry, gallery, insurances).
5. 🟡 controllers (factory) + 🟡 routes (loop) + public `/insurances`.
6. 🟡 the `computeChecklist` `portfolio` predicate — the gate.
7. 🟡 swagger.

---

## 12. Testing checklist (backend)

- [ ] Migration idempotent (run twice); `DESCRIBE doctor_profiles` shows 5 new cols; 9 new tables present.
- [ ] `POST /doctor/education` etc. create rows scoped to `req.user.id`; another doctor's id can't be forged (FK + `doctorId=userId` in service).
- [ ] `PATCH /doctor/education/:id` only updates the owner's row; someone else's id → 404.
- [ ] `DELETE` on a non-owned id → 404; gallery delete removes the stored file too.
- [ ] `PUT /doctor/insurances` with an unknown id → 422; a valid set replaces atomically (no dupes).
- [ ] `GET /doctor/profile` returns all new arrays; `GET /doctors/:slug` (approved) returns real `gender`, `headline`, structured `education`, services, etc.; a pending doctor still 404s publicly.
- [ ] `GET /doctor/onboarding` → `portfolio:false` until headline+gender+bio+photo+contact+≥1 education+≥1 service+≥1 experience all present, then flips `true`.
- [ ] `POST /doctor/submit` with any core section missing → `422 ONBOARDING_INCOMPLETE {steps}`; complete → `is_submitted=1`.
- [ ] Every `/doctor/*` route 403s a patient/admin token; `/insurances` needs no token.
- [ ] No response leaks `password_hash`; the public shape omits documents/notes/submission state.
