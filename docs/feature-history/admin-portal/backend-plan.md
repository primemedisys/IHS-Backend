# Backend — Admin Portal

How `backend/` gains the admin doctor-management surface. The verification queue, admin login, and admin seeding **already exist** (README §2); this plan adds (1) **create-and-approve a doctor** and (2) a small **reuse refactor** that lets admins drive the existing doctor services on any doctor id. Follows `backend/.claude/skills/backend-conventions` (layered flow, Joi-only validation, thin controllers, DRY). Read `README.md §4–6` first.

**No migration.** `verification_status` already defaults to `'pending'` and `registration_number`'s `PENDING-<id>` placeholder already exists (`user.service.createProfileRow`). Nothing about the schema changes.

---

## 1. Files touched / added

```
backend/src/
  middlewares/
    resolveDoctorId.js        ← NEW  (self vs. param → req.doctorId)
  services/
    adminDoctor.service.js    ← NEW  (createDoctor + auto-approve)
    user.service.js           ← EDIT (createProfileRow gains an overrides arg)
  controllers/
    doctor.controller.js      ← EDIT (req.user.id → req.doctorId, mechanical)
    adminDoctorManage.controller.js ← NEW (create; thin)
  validators/
    admin.validator.js        ← NEW  (createDoctor)
  routes/
    doctor.routes.js          ← EDIT (insert resolveDoctorId('self') into guard)
    adminDoctorManage.routes.js ← NEW (mounts the doctor controllers on /admin/doctors/:id/*)
    index.js                  ← EDIT (mount the new router)
  config/
    swagger.js                ← EDIT (document POST /admin/doctors + the :id/* surface)
```

`adminDoctor.controller` / `adminDoctor.routes` / `verification.service` (the queue + verdict) are **untouched** — they already work.

---

## 2. `POST /admin/doctors` — create + auto-approve

### 2.1 Validator (`validators/admin.validator.js`)
```js
const Joi = require("joi");

const createDoctor = Joi.object({
  name:     Joi.string().trim().min(2).max(120).required(),
  email:    Joi.string().trim().email().max(190).required(),
  password: Joi.string().min(8).max(72).required(), // admin-set; doctor can reset later
});

module.exports = { createDoctor };
```

### 2.2 Reuse `createProfileRow` with an overrides arg (`user.service.js`)
The one edit to shared code — so the admin path and the self path both create the profile row through the **same** helper (no second copy of the `PENDING-<id>` rule):
```js
// createProfileRow(user, tx, overrides = {})
async function createProfileRow(user, tx, overrides = {}) {
  if (user.role === ROLES.DOCTOR) {
    await DoctorProfile.create(
      { userId: user.id, registrationNumber: `PENDING-${user.id}`, ...overrides },
      { transaction: tx }
    );
  } else if (user.role === ROLES.PATIENT) {
    await PatientProfile.create({ userId: user.id, ...overrides }, { transaction: tx });
  }
}
```
Existing callers pass no `overrides` → behaviour unchanged.

### 2.3 Service (`services/adminDoctor.service.js`)
```js
const { sequelize, User } = require("../models");
const password = require("../utils/password");
const userService = require("./user.service");
const doctorService = require("./doctor.service");
const ApiError = require("../utils/ApiError");
const { ROLES, AUTH_PROVIDERS, ERROR_CODES } = require("../config/constants");

/**
 * Admin creates a doctor that is LIVE immediately: verification_status='approved'
 * + is_submitted=true (README §6). User + profile row are created atomically.
 */
async function createDoctor({ name, email, password: plain }) {
  const existing = await userService.findByEmail(email);
  if (existing) {
    throw ApiError.conflict("Email is already registered", { code: ERROR_CODES.EMAIL_IN_USE });
  }
  const passwordHash = await password.hash(plain);

  const user = await sequelize.transaction(async (tx) => {
    const created = await User.create(
      {
        name, email, passwordHash,
        role: ROLES.DOCTOR,
        authProvider: AUTH_PROVIDERS.LOCAL,
        isEmailVerified: true, // admin-vouched
      },
      { transaction: tx }
    );
    await userService.createProfileRow(created, tx, {
      verificationStatus: "approved",
      isSubmitted: true,
    });
    return created;
  });

  // Full profile in the admin-review shape so the UI can drop straight into the builder.
  return doctorService.getOwnProfile(user.id);
}

module.exports = { createDoctor };
```

### 2.4 Controller (`controllers/adminDoctorManage.controller.js`)
```js
const adminDoctorService = require("../services/adminDoctor.service");
const asyncHandler = require("../utils/asyncHandler");
const { created } = require("../utils/apiResponse");
const { serializeDoctorProfile } = require("../utils/serializers");

exports.create = asyncHandler(async (req, res) => {
  const profile = await adminDoctorService.createDoctor(req.body);
  return created(res, serializeDoctorProfile(profile), "Doctor created and approved");
});
```

Reuses the existing `serializeDoctorProfile` (never returns a raw instance; the `User.defaultScope` already hides `password_hash`).

---

## 3. The reuse refactor — admin edits any doctor with the doctor's own services

### 3.1 `resolveDoctorId` middleware (`middlewares/resolveDoctorId.js`)
```js
/**
 * Normalizes "which doctor is this request about" into req.doctorId, so the SAME
 * doctor.controller handlers serve both the owner (/doctor/*) and an admin acting
 * on a target (/admin/doctors/:id/*). Param mode 404s an unknown doctor early so
 * every downstream service call is guaranteed a real profile.
 */
const { DoctorProfile } = require("../models");
const ApiError = require("../utils/ApiError");

module.exports = (source) => async (req, _res, next) => {
  if (source === "self") {
    req.doctorId = req.user.id;
    return next();
  }
  // source === "param"
  const id = req.params.id;
  const exists = await DoctorProfile.findByPk(id, { attributes: ["userId"] });
  if (!exists) return next(ApiError.notFound("Doctor not found"));
  req.doctorId = id;
  return next();
};
```

### 3.2 Refactor `doctor.controller.js` — `req.user.id` → `req.doctorId`
Purely mechanical: every handler currently reads `req.user.id`; swap to `req.doctorId`. `req.body`, `req.params.id` (child-row ids), and `req.file` are unchanged. The `ownedHandlers` factory changes in exactly one place each (list/add/update/remove). Example:
```js
exports.getProfile = asyncHandler(async (req, res) => {
  const profile = await doctorService.getOwnProfile(req.doctorId); // was req.user.id
  return ok(res, serializeDoctorProfile(profile), "Your profile");
});
```
Because `doctor.service` / `verification.service` were **already** keyed by `userId`, no service changes are needed.

> Ownership safety note: on `/doctor/*`, `req.doctorId === req.user.id`, so a doctor can still only touch their own rows (child-row deletes remain scoped `where: { id, doctorId }` in the service). On `/admin/doctors/:id/*`, the admin guard authorizes acting on any id — intended.

### 3.3 Re-mount doctor routes with the self-resolver (`doctor.routes.js`)
Add `resolveDoctorId('self')` to the guard array — a one-line change, everything else identical:
```js
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];
```

### 3.4 Admin management router (`routes/adminDoctorManage.routes.js`)
Mount the **same** doctor controllers + validators under `/admin/doctors/:id/*`, guarded for admin and resolving the target from the param. This mirrors `doctor.routes.js` exactly (same paths after `:id`), so the surface can't drift.
```js
const router = require("express").Router();
const doctor = require("../controllers/doctor.controller");           // REUSED
const adminManage = require("../controllers/adminDoctorManage.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const upload = require("../middlewares/upload");
const schema = require("../validators/doctor.validator");
const adminSchema = require("../validators/admin.validator");
const { ROLES } = require("../config/constants");

const adminGuard = [authenticate, authorize(ROLES.ADMIN)];
const onDoctor = [...adminGuard, resolveDoctorId("param")]; // sets req.doctorId = :id

// Create + auto-approve
router.post("/doctors", ...adminGuard, validate(adminSchema.createDoctor), adminManage.create);

// Everything below is the /doctor/* surface, re-pointed at :id ────────────────
router.get("/doctors/:id/onboarding", ...onDoctor, doctor.onboarding);
router.get("/doctors/:id/profile", ...onDoctor, doctor.getProfile);
router.patch("/doctors/:id/profile", ...onDoctor, validate(schema.updateProfile), doctor.updateProfile);
router.get("/doctors/:id/preview", ...onDoctor, doctor.preview);

router.put("/doctors/:id/specializations", ...onDoctor, validate(schema.setSpecializations), doctor.setSpecializations);
router.put("/doctors/:id/languages", ...onDoctor, validate(schema.setLanguages), doctor.setLanguages);

router.route("/doctors/:id/awards").all(...onDoctor).get(doctor.listAwards).post(validate(schema.createAward), doctor.addAward);
router.delete("/doctors/:id/awards/:awardId", ...onDoctor, doctor.removeAward);
// … links, keywords: same shape …

router.get("/doctors/:id/documents", ...onDoctor, doctor.listDocuments);
router.post("/doctors/:id/documents", ...onDoctor, upload.single("file"), validate(schema.uploadDocument), doctor.uploadDocument);
router.delete("/doctors/:id/documents/:docId", ...onDoctor, doctor.removeDocument);

router.post("/doctors/:id/photo", ...onDoctor, upload.single("file"), doctor.uploadPhoto);

// Portfolio v2 owned sections — reuse the SAME key→schema loop as doctor.routes.js
const OWNED_SECTIONS = {
  education: schema.createEducation, experience: schema.createExperience,
  services: schema.createService, publications: schema.createPublication,
  memberships: schema.createMembership, faqs: schema.createFaq,
};
for (const [key, createSchema] of Object.entries(OWNED_SECTIONS)) {
  const h = doctor[key];
  router.route(`/doctors/:id/${key}`).all(...onDoctor).get(h.list).post(validate(createSchema), h.add);
  router.route(`/doctors/:id/${key}/:rowId`).all(...onDoctor)
    .patch(validate(schema.partialOf(createSchema)), h.update).delete(h.remove);
}

router.route("/doctors/:id/gallery").all(...onDoctor).get(doctor.listGallery)
  .post(upload.single("file"), validate(schema.uploadGallery), doctor.addGallery);
router.delete("/doctors/:id/gallery/:imgId", ...onDoctor, doctor.removeGallery);
router.put("/doctors/:id/insurances", ...onDoctor, validate(schema.setInsurances), doctor.setInsurances);

// Clinics & availability (docs-shared/feature-plans/clinics-availability) mount the SAME way once built.
module.exports = router;
```

> **Child-row param naming.** `/doctor/*` uses `:id` for the child row; here `:id` is the doctor, so child ids use a distinct name (`:awardId`, `:docId`, `:rowId`, …). The controllers already read child ids from `req.params.id` — so either (a) keep the doctor id in a differently-named param on this router (e.g. `/admin/doctors/:doctorId/...` with `resolveDoctorId` reading `req.params.doctorId`, leaving `:id` free for the child row — **recommended**, zero controller change), or (b) have the controllers read the child id from a normalized field. Option (a) is cleaner; adopt `:doctorId` for the doctor and keep `:id` for child rows so the reused controllers need no change beyond `req.user.id → req.doctorId`.

### 3.5 Mount it (`routes/index.js`)
```js
const adminDoctorManageRoutes = require("./adminDoctorManage.routes");
router.use("/admin", adminDoctorManageRoutes); // POST /admin/doctors + /admin/doctors/:doctorId/*
```
Keep the existing `router.use("/admin", adminDoctorRoutes)` (the verification queue) — Express merges both routers under `/admin`; their paths don't collide (`/doctors/:id/verify` vs. `/doctors/:doctorId/profile`). To avoid `:id` vs `:doctorId` ambiguity across the two routers, prefer distinct sub-paths or fold both into one admin router. Simplest: **merge** the verification routes into `adminDoctorManage.routes.js` so all `/admin/doctors*` live in one file with one param convention.

---

## 4. Serializers

No new serializers. `serializeDoctorProfile` (admin/owner shape) and `serializeUser` already exist and are reused by both the create response and the mounted editing handlers. `serializeDoctorProfile` already excludes `password_hash` (User `defaultScope`).

---

## 5. Swagger (`config/swagger.js`)

Add:
- `POST /admin/doctors` — request `{ name, email, password }`, `201 { data: DoctorProfile }`, `409 EMAIL_IN_USE`.
- A note under the `/admin/doctors/:doctorId/*` paths that they mirror the documented `/doctor/*` bodies exactly (link to those definitions rather than re-describing each).

Per convention rule #10, a route without a doc entry is incomplete — but the `:doctorId/*` bodies reuse the existing `/doctor/*` schemas verbatim, so reference them.

---

## 6. Validation, errors, envelope

- **Validation:** only `createDoctor` is new; every `:doctorId/*` route reuses the existing `doctor.validator` schemas via the same `validate(...)` middleware. No validation in controllers.
- **Errors:** reuse factories — `ApiError.conflict(EMAIL_IN_USE)` on create, `ApiError.notFound` from `resolveDoctorId('param')` on an unknown doctor, `422 VALIDATION_ERROR` from Joi. No new error codes.
- **Envelope:** `created(...)` / `ok(...)` throughout; errors flow through `errorHandler`.

---

## 7. Optional lifecycle endpoints (off by default — README §5.4)

If product wants them later, add to the admin router (small, self-contained):
- `PATCH /admin/doctors/:doctorId/status` `{ isActive }` → `User.update({ isActive }, { where: { id } })` + revoke sessions on deactivate (`tokenService.revokeAllForUser`).
- `POST /admin/doctors/:doctorId/reset-password` → reuse `authService.forgotPassword`-style token issue, or set a new hash directly and `revokeAllForUser`.

Both reuse existing services; neither is required by the PRD. Leave out of the first cut.

---

## 8. Test / verify checklist (backend)

- [ ] `POST /admin/doctors` (admin token) creates a `doctor` user + profile with `verification_status='approved'`, `is_submitted=true`; duplicate email → `409 EMAIL_IN_USE`.
- [ ] The created doctor appears in **public** `GET /doctors` / `/doctors/:slug` **immediately** (no verify step).
- [ ] A **self-registered** doctor still lands `pending` and is absent from public reads until `POST /admin/doctors/:doctorId/verify {decision:'approved'}`.
- [ ] `PATCH /admin/doctors/:doctorId/profile`, `PUT …/specializations`, section CRUD, `POST …/documents`, `POST …/photo` all persist against the target doctor (admin token).
- [ ] Regression: the **doctor app** still works end-to-end after the `req.doctorId` refactor (own profile edits, uploads, submit) — a doctor still can't touch another doctor's rows.
- [ ] `/admin/doctors/:doctorId/*` returns `403 FORBIDDEN` for a doctor/patient token and `404` for an unknown doctor id.
- [ ] `password_hash` never appears in any admin response.
- [ ] `npm run migrate` unaffected (no new migration); `npm run seed:admin` still idempotent.
</content>
