# Backend — Doctor Registration & Portfolio

**Stack:** Node.js + **Express 5** + **Sequelize 6** + **mysql2**, CommonJS. Validation with **Joi**. This extends the built auth feature under `backend/src/` — copy its shape. The layered flow is non-negotiable (see `.claude/skills/backend-conventions`):

```
route → rateLimiter? → validate(joiSchema) → authenticate → authorize('doctor') → controller → service → model
```

Read `README.md` first for scope, the state machine, and the endpoint catalog. This file is the "how to build the backend" companion. **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

---

## 1. Migration — `src/db/migrations/002_doctor_portfolio.sql` 🔵

Forward-only, idempotent (`CREATE TABLE IF NOT EXISTS`), applied by `npm run migrate` (tracked in `_migrations`). Lifts the relevant tables verbatim from `docs/dbstruct.md` (§4, §5, §6b–6e, §7, §18b) plus the one new column. Keep column names/types **exactly** as `dbstruct.md` so the hand-written schema stays the source of truth.

```sql
USE clinic_platform;

-- one new column on the existing table: draft vs submitted (README §3)
ALTER TABLE doctor_profiles
  ADD COLUMN IF NOT EXISTS is_submitted TINYINT(1) NOT NULL DEFAULT 0 AFTER verification_status;

-- lookups (idempotent; dbstruct.md already seeds these in dev — the seed is
-- re-run safe because of the UNIQUE slug/name keys)
CREATE TABLE IF NOT EXISTS specializations ( ... );   -- dbstruct.md §4
CREATE TABLE IF NOT EXISTS languages       ( ... );   -- dbstruct.md §5

-- M:N
CREATE TABLE IF NOT EXISTS doctor_specializations ( ... );   -- §6d
CREATE TABLE IF NOT EXISTS doctor_languages       ( ... );   -- §6e

-- 1:M portfolio + documents
CREATE TABLE IF NOT EXISTS doctor_awards          ( ... );   -- §6b
CREATE TABLE IF NOT EXISTS doctor_links           ( ... );   -- §6c
CREATE TABLE IF NOT EXISTS doctor_documents       ( ... );   -- §7
CREATE TABLE IF NOT EXISTS doctor_search_keywords ( ... );   -- §18b
```

> Copy the full `CREATE TABLE` bodies from `dbstruct.md` (they already carry the right FKs, indexes, and enums). Do **not** create `clinics`, `*_availability`, or `doctor_bank_details` here — those belong to the next plan's migration. Also add the seed `INSERT`s for `specializations`/`languages` from `dbstruct.md §SEED` if a fresh DB needs them (guard with the existing `UNIQUE` keys so re-running is safe).

Verify after running: `SHOW TABLES;` shows the 6 new tables + 2 lookups, and `DESCRIBE doctor_profiles;` shows `is_submitted`.

---

## 2. Models 🔵 (+ 🟡 `doctorProfile.model.js`, 🟡 `models/index.js`)

One model file per table, registered through `models/index.js` (never imported directly elsewhere). Match the existing camelCase-field → snake_case-column style already used in `user.model.js` / `doctorProfile.model.js`.

**🟡 `models/doctorProfile.model.js`** — it currently maps only a subset. Add `isSubmitted` (BOOLEAN, default false). The rest of the columns are already present. No other change.

**🔵 New model files:**

| File | Table | Notes |
|---|---|---|
| `specialization.model.js` | `specializations` | `id, name, slug`. |
| `language.model.js` | `languages` | `id, name`. |
| `doctorSpecialization.model.js` | `doctor_specializations` | junction (composite PK). |
| `doctorLanguage.model.js` | `doctor_languages` | junction. |
| `doctorAward.model.js` | `doctor_awards` | `id, doctorId, title, description, awardYear`. |
| `doctorLink.model.js` | `doctor_links` | `id, doctorId, linkType(enum), url`. |
| `doctorDocument.model.js` | `doctor_documents` | `id, doctorId, docType(enum), fileUrl, uploadedAt`. |
| `doctorSearchKeyword.model.js` | `doctor_search_keywords` | `id, doctorId, keyword, weight, isApproved`. |

**🟡 `models/index.js` — associations** (all FKs point at `doctor_profiles.user_id`, i.e. `DoctorProfile`'s PK `userId`):

```js
// M:N specialties & languages — through the junction tables
DoctorProfile.belongsToMany(Specialization, {
  through: DoctorSpecialization, foreignKey: "doctorId", otherKey: "specializationId", as: "specializations",
});
Specialization.belongsToMany(DoctorProfile, {
  through: DoctorSpecialization, foreignKey: "specializationId", otherKey: "doctorId", as: "doctors",
});
DoctorProfile.belongsToMany(Language, {
  through: DoctorLanguage, foreignKey: "doctorId", otherKey: "languageId", as: "languages",
});

// 1:M portfolio + documents
DoctorProfile.hasMany(DoctorAward,         { foreignKey: "doctorId", as: "awards",   onDelete: "CASCADE" });
DoctorProfile.hasMany(DoctorLink,          { foreignKey: "doctorId", as: "links",    onDelete: "CASCADE" });
DoctorProfile.hasMany(DoctorDocument,      { foreignKey: "doctorId", as: "documents",onDelete: "CASCADE" });
DoctorProfile.hasMany(DoctorSearchKeyword, { foreignKey: "doctorId", as: "keywords", onDelete: "CASCADE" });
```

Export every new model + junction from `models/index.js`.

**Slug (README §4.2, Q1).** No slug column. Add a pure helper in `utils/slug.js` 🔵: `doctorSlug(name, userId) → "dr-" + kebab(name) + "-" + userId`. Reverse-lookup on the public route parses the trailing `-<id>` and loads by PK — O(1), no new column, stable across name edits (the id suffix is the real key; the name part is cosmetic).

---

## 3. Validators — `validators/doctor.validator.js` 🔵 (Joi)

The ONLY place request shapes are checked. One schema per writable endpoint; wired in the route via `validate(schema.x)`. Import enums/limits, don't retype literals.

```js
const Joi = require("joi");

const updateProfile = Joi.object({
  qualification:      Joi.string().trim().max(255),
  registrationNumber: Joi.string().trim().max(100),      // real value; uniqueness checked in service
  experienceYears:    Joi.number().integer().min(0).max(80),
  bio:                Joi.string().trim().max(5000),
  onlineFee:          Joi.number().min(0).allow(null),
}).min(1);

const setSpecializations = Joi.object({ specializationIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(5).required() });
const setLanguages        = Joi.object({ languageIds:       Joi.array().items(Joi.number().integer().positive()).min(1).max(10).required() });

const createAward   = Joi.object({ title: Joi.string().trim().max(255).required(), description: Joi.string().max(500).allow("",null), awardYear: Joi.number().integer().min(1950).max(2100) });
const createLink    = Joi.object({ linkType: Joi.string().valid("website","linkedin","instagram","youtube","other").required(), url: Joi.string().uri().max(300).required() });
const createKeyword = Joi.object({ keyword: Joi.string().trim().max(150).required(), weight: Joi.number().integer().min(1).max(5).default(1) });

const uploadDocument = Joi.object({ docType: Joi.string().valid("degree_certificate","id_proof","council_registration","other").required() });
// the file itself is validated in middleware (mimetype/size), not Joi

// admin
const verifyDoctor = Joi.object({ decision: Joi.string().valid("approved","rejected").required(), notes: Joi.string().max(500).allow("",null) });
```

Add a `DOC_TYPES`, `LINK_TYPES` block to `config/constants.js` 🟡 and reference them in both the model enums and these schemas (no string-literal drift).

---

## 4. Services — `services/doctor.service.js` 🔵 (+ `upload.service.js`, `verification.service.js`)

All business logic + all DB access. Reuse `user.service` for anything user-shaped; never re-query what it already exposes. Multi-row writes go in `sequelize.transaction`. No queries in loops — use `include`, `Op.in`, `bulkCreate`, and set-replace patterns.

**`services/doctor.service.js`** — the doctor-owned surface:

```js
getOwnProfile(userId)          // DoctorProfile.findByPk with include: specializations, languages,
                               //   awards, links, documents, keywords, + User (name/photo). ONE query.
updateProfile(userId, patch)   // if patch.registrationNumber: reject if it collides with another
                               //   doctor (Op.ne self) -> ApiError.conflict(REG_NUMBER_IN_USE).
                               //   Then DoctorProfile.update.
setSpecializations(userId, ids)// validate ids exist (findAll Op.in, count match); then replace the
                               //   junction set atomically: destroy where doctorId + bulkCreate. (tx)
setLanguages(userId, ids)      // same pattern.
addAward / removeAward         // create / destroy (ownership: where doctorId=userId).
addLink  / removeLink          // ""
addKeyword / removeKeyword     // "" ; unique (doctorId, keyword) -> 409 on dupe.
```

**`services/verification.service.js`** 🔵 — the completeness engine + submit + admin verdict, kept in ONE place so the `GET /onboarding` checklist and the `POST /submit` guard can never diverge:

```js
// The single source of truth for "what's done". Returns a per-step checklist.
computeChecklist(profile) {         // profile already eager-loaded
  return {
    professional: Boolean(profile.qualification && profile.experienceYears >= 0
                    && profile.registrationNumber && !profile.registrationNumber.startsWith("PENDING-")),
    specialties:  profile.specializations.length >= 1,
    portfolio:    Boolean(profile.bio && profile.user.profilePhotoUrl),   // photo per README Q2
    documents:    REQUIRED_DOC_TYPES.every((t) => profile.documents.some((d) => d.docType === t)),
    // deferred steps read here later, gated by ONBOARDING_REQUIRED_STEPS config:
    clinics: null, availability: null, bank: null,
  };
}
getOnboarding(userId)   // load profile + include; return { steps: checklist, canSubmit, isSubmitted, verificationStatus, verificationNotes }
submit(userId)          // recompute; if any REQUIRED step false -> ApiError(422, ONBOARDING_INCOMPLETE, {steps});
                        // else set is_submitted=1 (status stays 'pending').

// admin
listForReview(status)          // DoctorProfile.findAll where verificationStatus, include User + documents.
reviewDoctor(id, {decision, notes})  // set verificationStatus=decision, verification_notes=notes.
```

`REQUIRED_DOC_TYPES` and `ONBOARDING_REQUIRED_STEPS` live in `config/constants.js` — adding clinics/availability/bank to the gate later is a one-line edit (README §5.2).

**`services/upload.service.js`** 🔵 — the storage abstraction (README §6):

```js
// driver selected by env.STORAGE_DRIVER ('local' | 's3')
put(buffer, { keyPrefix, filename, mimetype }) -> { url, key }
remove(key)
// local driver: writes to `<UPLOAD_DIR>/<keyPrefix>/<uuid>-<filename>`, returns `${env.PUBLIC_URL}/uploads/...`
// s3 driver:    PutObjectCommand to env.S3_BUCKET, returns the object URL
```

Document/photo controllers call `upload.service.put(...)` then persist the returned `url` — they never know which driver ran.

---

## 5. Controllers & routes 🔵

**Controllers stay thin** (`controllers/doctor.controller.js`, `adminDoctor.controller.js`): read validated input + `req.user.id`, call exactly one service fn, serialize, respond via `ok()/created()`. Wrap in `asyncHandler`. No `Model.` calls, no `if` about business state.

```js
// controllers/doctor.controller.js (representative)
exports.updateProfile = asyncHandler(async (req, res) => {
  const profile = await doctorService.updateProfile(req.user.id, req.body);
  ok(res, serializeDoctorProfile(profile));
});
```

**`routes/doctor.routes.js`** 🔵 — every doctor-owned route is `authenticate` + `authorize(ROLES.DOCTOR)`:

```js
const guard = [authenticate, authorize(ROLES.DOCTOR)];
router.get   ("/onboarding",        ...guard, doctor.onboarding);
router.get   ("/profile",           ...guard, doctor.getProfile);
router.patch ("/profile",           ...guard, validate(schema.updateProfile), doctor.updateProfile);
router.put   ("/specializations",   ...guard, validate(schema.setSpecializations), doctor.setSpecializations);
router.put   ("/languages",         ...guard, validate(schema.setLanguages), doctor.setLanguages);
router.route ("/awards")            .all(...guard).get(doctor.listAwards).post(validate(schema.createAward), doctor.addAward);
router.delete("/awards/:id",        ...guard, doctor.removeAward);
router.route ("/links")             .all(...guard).get(doctor.listLinks).post(validate(schema.createLink), doctor.addLink);
router.delete("/links/:id",         ...guard, doctor.removeLink);
router.route ("/keywords")          .all(...guard).get(doctor.listKeywords).post(validate(schema.createKeyword), doctor.addKeyword);
router.delete("/keywords/:id",      ...guard, doctor.removeKeyword);
router.get   ("/documents",         ...guard, doctor.listDocuments);
router.post  ("/documents",         ...guard, upload.single("file"), validate(schema.uploadDocument), doctor.uploadDocument);
router.delete("/documents/:id",     ...guard, doctor.removeDocument);
router.post  ("/photo",             ...guard, upload.single("file"), doctor.uploadPhoto);
router.post  ("/submit",            ...guard, doctor.submit);
```

**`routes/doctorsPublic.routes.js`** 🔵 (no auth): `GET /doctors/:slug`, `GET /specializations`, `GET /languages`.
**`routes/adminDoctor.routes.js`** 🔵: `authenticate` + `authorize(ROLES.ADMIN)` for the three review endpoints.

**🟡 `routes/index.js`** — mount them (one line each):
```js
router.use("/doctor",  require("./doctor.routes"));
router.use("/admin",   require("./adminDoctor.routes"));
router.use("/",        require("./doctorsPublic.routes"));   // /doctors/:slug, /specializations, /languages
```

> Note the `upload` middleware order: `upload.single("file")` runs **before** `validate` so `req.body.docType` (a multipart text field) is populated when Joi checks it.

---

## 6. Upload middleware — `middlewares/upload.js` 🔵

`multer` memory storage + a `fileFilter` (allow `application/pdf`, `image/png`, `image/jpeg`) + `limits.fileSize` (e.g. 5 MB). Rejections become an `ApiError(422)` via the error handler. The service, not the middleware, decides where bytes go (§4).

```js
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new ApiError(422, "Unsupported file type")),
});
```

Static serving for the local driver: in `app.js` 🟡 add `app.use("/uploads", express.static(env.UPLOAD_DIR))` (dev only; behind S3 in prod).

---

## 7. Serializers — `utils/serializers.js` 🟡

Add mappers so no raw Sequelize instance ever reaches the client (the boundary that keeps internal columns out and camelCases the shape the frontend types declare):

```js
serializeDoctorProfile(profile)   // -> { id, slug, qualification, registrationNumber, experienceYears,
                                  //      bio, onlineFee, verificationStatus, isSubmitted, avgRating,
                                  //      ratingCount, name, photoUrl, specializations[], languages[],
                                  //      awards[], links[], documents[], keywords[] }
serializePublicDoctor(profile)    // the discovery/portfolio shape matching frontend `DoctorDetail`
                                  //   (omits documents, is_submitted, internal notes)
serializeSpecialization(s) / serializeLanguage(l)
```

`serializePublicDoctor` maps onto the existing `frontend-doctor` `Doctor`/`DoctorDetail` type (see `frontend-plan.md §5`) so the public page swaps mock→API with no type churn. Clinics/availability arrays come back `[]` until the next plan fills them.

---

## 8. Config & env 🟡

`config/env.js` (Joi-validated at boot — the ONLY place `process.env` is read) gains:

```
STORAGE_DRIVER=local            # local | s3
UPLOAD_DIR=./uploads            # local driver root
PUBLIC_URL=http://localhost:5000
MAX_UPLOAD_MB=5
# s3 (only required when STORAGE_DRIVER=s3)
S3_BUCKET=, S3_REGION=, AWS_ACCESS_KEY_ID=, AWS_SECRET_ACCESS_KEY=
```

Make the S3 keys `.when('STORAGE_DRIVER','s3')`-required so a misconfigured prod fails fast at boot.

`config/constants.js` 🟡: add `DOC_TYPES`, `LINK_TYPES`, `REQUIRED_DOC_TYPES`, `ONBOARDING_REQUIRED_STEPS`, and new `ERROR_CODES` (`REG_NUMBER_IN_USE`, `ONBOARDING_INCOMPLETE`, `DOC_REQUIRED`).

---

## 9. Swagger — `config/swagger.js` 🟡

Every new endpoint gets an OpenAPI entry (a route with no doc is incomplete, served at `/api/docs`). Group them under `Doctor`, `Doctors (public)`, and `Admin – Verification` tags. Document the multipart bodies for the two upload routes explicitly.

---

## 10. Dependencies to add

```bash
cd backend
npm i multer
npm i @aws-sdk/client-s3        # only needed for the s3 driver; safe to install now
```

Add a script if helpful; `npm run migrate` already exists.

---

## 11. Build order (backend)

1. 🔵 `002_doctor_portfolio.sql` → `npm run migrate`; 🟡 extend `DoctorProfile`; 🔵 models + associations in `index.js`.
2. 🔵 serializers + `utils/slug.js`; 🔵 public routes (`/specializations`, `/languages`, `/doctors/:slug`) → smoke-test read path first.
3. 🔵 `doctor.validator.js`; 🔵 `doctor.service.js` (profile/specialties/languages/awards/links/keywords) + controllers + `doctor.routes.js`.
4. 🔵 `upload.js` middleware + `upload.service.js`; documents + photo endpoints.
5. 🔵 `verification.service.js` → `/doctor/onboarding` + `/doctor/submit`.
6. 🔵 admin review endpoints.
7. 🟡 swagger entries as each route lands; 🟡 env + constants alongside.

---

## 12. Testing checklist (backend)

- [ ] Migration is idempotent (run twice, no error); `doctor_profiles.is_submitted` exists; 8 tables present.
- [ ] `GET /doctors/:slug` returns only `approved` doctors; a `pending` doctor 404s publicly but is visible via `GET /doctor/profile` with their own token.
- [ ] `PATCH /doctor/profile` with a reg number owned by another doctor → `409 REG_NUMBER_IN_USE`; own placeholder → OK.
- [ ] `PUT /specializations` with an unknown id → 422; valid set replaces (no duplicate rows, old removed) inside one transaction.
- [ ] Document upload stores the file, returns a URL, lists back; oversize/wrong-mime → 422; delete removes row (+ file for local driver).
- [ ] `GET /doctor/onboarding` flips each step's flag exactly when its data becomes complete; `canSubmit` matches the four required steps.
- [ ] `POST /doctor/submit` with an incomplete step → `422 ONBOARDING_INCOMPLETE` (with `steps`); complete → `is_submitted=1`.
- [ ] `POST /admin/doctors/:id/verify {approved}` flips status; the doctor then appears in `/doctors/:slug`; `{rejected, notes}` surfaces notes in `/doctor/onboarding`.
- [ ] Every doctor-owned route rejects a patient/admin token with 403; public routes need no token.
- [ ] No response anywhere leaks `password_hash` or another doctor's documents.
