# Backend Auth — Implementation Plan

**Stack:** Node.js + **Express 5** + **Sequelize 6** + **mysql2** (CommonJS — `"type": "commonjs"` in `backend/package.json`). The `backend/src/` directory is currently empty; this is a greenfield build.

Read `README.md` first for the token strategy, endpoint catalog, DB additions, and `.env` contract. This file is the "how to build the backend" companion.

---

## 1. Dependencies to add

```bash
# runtime
npm i dotenv bcryptjs jsonwebtoken google-auth-library nodemailer \
      cors helmet cookie-parser morgan express-rate-limit zod ms

# dev
npm i -D nodemon
```

- **bcryptjs** — password hashing (pure JS, no native build headaches on Windows).
- **jsonwebtoken** — sign/verify access tokens.
- **google-auth-library** — verify Google ID tokens server-side.
- **nodemailer** — SMTP email (reset, verification, later notifications).
- **zod** — request validation (mirrors the frontend's zod schemas for a shared mental model).
- **express-rate-limit** — brute-force protection on auth endpoints.
- **helmet / cors / cookie-parser / morgan** — standard hardening + logging.

Add scripts to `package.json`:

```json
"scripts": {
  "dev": "nodemon src/server.js",
  "start": "node src/server.js",
  "seed:admin": "node src/seeders/admin.seeder.js"
}
```

---

## 2. Folder structure

```
backend/
├── .env                      # (git-ignored) — see README §6
├── package.json
└── src/
    ├── server.js             # boot: connect DB, run admin seed, listen
    ├── app.js                # express app: middleware, routes, error handler
    ├── config/
    │   ├── env.js            # load + validate process.env (zod)
    │   ├── database.js       # Sequelize instance
    │   └── constants.js      # roles, token TTLs, enums
    ├── models/
    │   ├── index.js          # init models + associations
    │   ├── user.model.js
    │   ├── refreshToken.model.js
    │   ├── passwordResetToken.model.js
    │   ├── emailVerificationToken.model.js   # optional
    │   ├── doctorProfile.model.js            # minimal, for /me + profile
    │   └── patientProfile.model.js           # minimal, for /me + profile
    ├── middleware/
    │   ├── authenticate.js   # verify access token → req.user
    │   ├── authorize.js      # requireRole('admin'|'doctor'|'patient')
    │   ├── validate.js       # run a zod schema against req
    │   ├── rateLimiters.js   # login/forgot/refresh limiters
    │   └── errorHandler.js   # central error → JSON envelope
    ├── utils/
    │   ├── ApiError.js       # typed error with statusCode
    │   ├── apiResponse.js    # ok(res, data) / created(...)
    │   ├── password.js       # hash() / compare()
    │   ├── tokens.js         # randomToken(), sha256()
    │   └── asyncHandler.js   # wrap async controllers
    ├── services/
    │   ├── token.service.js  # issue/verify access + refresh rotation
    │   ├── auth.service.js   # register/login/google/reset/profile logic
    │   ├── google.service.js # verify Google ID token
    │   └── mail.service.js   # nodemailer transport + sendReset/sendVerify
    ├── controllers/
    │   ├── auth.controller.js
    │   └── adminAuth.controller.js
    ├── validators/
    │   └── auth.validator.js  # zod schemas for each endpoint body
    ├── routes/
    │   ├── index.js           # mount /api/*
    │   └── auth.routes.js
    ├── templates/emails/
    │   ├── reset-password.html
    │   └── verify-email.html
    └── seeders/
        └── admin.seeder.js
```

---

## 3. Config layer

**`config/env.js`** — validate once, export typed config (same philosophy as the frontend's `config/env.ts`):

```js
const { z } = require("zod");
require("dotenv").config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5000),
  API_PREFIX: z.string().default("/api"),
  CLIENT_URL: z.string().url(),

  DB_HOST: z.string(), DB_PORT: z.coerce.number().default(3306),
  DB_NAME: z.string(), DB_USER: z.string(), DB_PASSWORD: z.string(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),

  ADMIN_NAME: z.string().default("Platform Admin"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),

  GOOGLE_CLIENT_ID: z.string(),

  SMTP_HOST: z.string(), SMTP_PORT: z.coerce.number(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string(), SMTP_PASSWORD: z.string(),
  MAIL_FROM: z.string(),

  RESET_TOKEN_TTL_MINUTES: z.coerce.number().default(45),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
module.exports = parsed.data;
```

**`config/database.js`** — Sequelize instance from the validated env; export `sequelize`.

---

## 4. Models (Sequelize)

Only the auth-relevant models are needed now; the rest of `dbstruct.md` gets modeled as those features are built.

**`user.model.js`** (maps the existing `users` table):

```js
// fields: id, role, name, email, phone, password_hash, auth_provider,
//         google_id, profile_photo_url, is_active, is_email_verified,
//         is_phone_verified, created_at, updated_at
// - defaultScope EXCLUDES password_hash (never leak it)
// - a `withPassword` scope re-includes it for login/change-password only
User.addScope("withPassword", {}); // include password_hash explicitly
```

Key rule: **default query results must not include `password_hash`.** Use `defaultScope: { attributes: { exclude: ['password_hash'] } }` and a named scope to opt back in during login.

**`refreshToken.model.js`**, **`passwordResetToken.model.js`**, **`emailVerificationToken.model.js`** — map the tables from README §4.

**Associations** (`models/index.js`):
```
User.hasMany(RefreshToken,        { foreignKey: 'user_id' });
User.hasMany(PasswordResetToken,  { foreignKey: 'user_id' });
User.hasOne(DoctorProfile,        { foreignKey: 'user_id' });
User.hasOne(PatientProfile,       { foreignKey: 'user_id' });
```

> In dev you may `sequelize.sync()` the auth tables; for anything shared with `dbstruct.md` prefer **migrations** so you don't fight the hand-written SQL.

---

## 5. Core utilities

**`utils/password.js`**
```js
const bcrypt = require("bcryptjs");
exports.hash    = (plain) => bcrypt.hash(plain, 12);
exports.compare = (plain, hash) => bcrypt.compare(plain, hash);
```

**`utils/tokens.js`**
```js
const crypto = require("crypto");
exports.randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
exports.sha256      = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
```

**`utils/ApiError.js`** — `new ApiError(401, "Invalid credentials")`; carries `statusCode`, optional `code`/`details`.
**`utils/apiResponse.js`** — `ok(res, data)` → `res.json({ data })`; `created(res, data)` → `201`.
**`utils/asyncHandler.js`** — `fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next)`.

---

## 6. Token service (`services/token.service.js`)

The single owner of token issuing + refresh rotation. Signatures:

```js
signAccessToken(user)            // -> JWT string (claims: sub, role, email)
issueTokens(user, req)           // -> { accessToken, refreshToken }; persists hashed refresh row
rotateRefreshToken(rawToken,req) // -> { user, tokens } or throws (with reuse detection)
revokeRefreshToken(rawToken)     // logout: mark revoked_at
revokeAllForUser(userId)         // used on password reset / theft
```

**`issueTokens`**
1. `accessToken = jwt.sign({ sub, role, email }, JWT_ACCESS_SECRET, { expiresIn: JWT_ACCESS_TTL })`.
2. `raw = randomToken(48)`; store `RefreshToken { user_id, token_hash: sha256(raw), expires_at: now + N days, user_agent, ip }`.
3. Return `{ accessToken, refreshToken: raw }`.

**`rotateRefreshToken`** (implements README §3):
1. `row = findOne({ token_hash: sha256(raw) })`.
2. Not found → `ApiError(401)`.
3. `row.revoked_at != null` → **reuse detected**: `revokeAllForUser(row.user_id)` then `ApiError(401)`.
4. `row.expires_at < now` → `ApiError(401)`.
5. Mark `row.revoked_at = now`; `issueTokens(user)`; return new pair + user.

---

## 7. Auth service (`services/auth.service.js`)

Pure business logic (controllers stay thin). Key methods:

```js
registerLocal({ name, email, phone, password, role })
  // 1. reject role 'admin'
  // 2. 409 if email exists
  // 3. create user (auth_provider='local', password_hash=hash(password))
  // 4. create role profile row (doctor_profiles / patient_profiles)
  // 5. (optional) create email verification token + mail.sendVerify()
  // 6. return { user, tokens: tokenService.issueTokens(user, req) }

loginLocal({ email, password }, req)
  // find user WITH password scope; 401 if missing / password_hash null / mismatch
  // block if role === 'admin' (admins use /auth/admin/login)
  // 401 if !is_active
  // return { user, tokens }

loginAdmin({ email, password }, req)
  // same as loginLocal but REQUIRE role === 'admin'

googleAuth({ credential, role }, req)
  // payload = googleService.verify(credential)
  // require payload.email_verified
  // find user by google_id OR email
  //   - found: (link google_id if it was a local account), login
  //   - not found: require `role` (doctor|patient), create user
  //       (auth_provider='google', google_id, is_email_verified=1, no password)
  // return { user, tokens }

forgotPassword({ email })
  // find user; if none -> return silently (no enumeration)
  // create PasswordResetToken(raw hashed, ttl), mail.sendReset(link with raw)

resetPassword({ token, password })
  // row = find by sha256(token), not used, not expired -> else 400
  // user.password_hash = hash(password); mark used_at
  // tokenService.revokeAllForUser(user.id)   // kill existing sessions

getMe(userId)          // user + role profile
updateProfile(userId, patch)   // whitelist fields per role
```

---

## 8. Google verification (`services/google.service.js`)

```js
const { OAuth2Client } = require("google-auth-library");
const env = require("../config/env");
const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

exports.verify = async (credential) => {
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: env.GOOGLE_CLIENT_ID,          // guards against tokens for other apps
  });
  const p = ticket.getPayload();             // { sub, email, email_verified, name, picture }
  if (!p?.email_verified) throw new ApiError(401, "Google email not verified");
  return { googleId: p.sub, email: p.email, name: p.name, picture: p.picture };
};
```

Frontend flow: Google Identity button returns a **credential (ID token)** → frontend POSTs it to `/auth/google`. Backend verifies here. No Google session is kept — we mint our own JWT pair immediately.

---

## 9. Mail service (`services/mail.service.js`)

```js
const nodemailer = require("nodemailer");
const env = require("../config/env");

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
});

async function send({ to, subject, html }) {
  return transport.sendMail({ from: env.MAIL_FROM, to, subject, html });
}

exports.sendPasswordReset = (user, rawToken) => {
  const link = `${env.CLIENT_URL}/reset-password?token=${rawToken}`;
  return send({ to: user.email, subject: "Reset your password",
    html: renderTemplate("reset-password", { name: user.name, link }) });
};

exports.sendVerifyEmail = (user, rawToken) => {
  const link = `${env.CLIENT_URL}/verify-email?token=${rawToken}`;
  return send({ to: user.email, subject: "Verify your email",
    html: renderTemplate("verify-email", { name: user.name, link }) });
};
```

- The **raw** token goes in the link; the DB stored only its hash.
- `renderTemplate` = read the HTML file in `templates/emails/` and interpolate `{{name}}`/`{{link}}` (a tiny replace, or add `handlebars` if you prefer).
- Optionally log each send into the existing `email_notifications` table from `dbstruct.md`.
- For local dev without SMTP, fall back to `nodemailer.createTestAccount()` (Ethereal) and log the preview URL.

---

## 10. Middleware

**`authenticate.js`**
```js
// read Authorization: Bearer <token>; jwt.verify with JWT_ACCESS_SECRET
// -> req.user = { id: sub, role, email }; 401 on missing/invalid/expired
```

**`authorize.js`**
```js
const authorize = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, "Forbidden"));
```

**`rateLimiters.js`** — an `authLimiter` (e.g., 10/min/IP) applied to login/admin-login/forgot/refresh.
**`validate.js`** — `validate(schema)` parses `req.body` with a zod schema, 422 on failure.
**`errorHandler.js`** — last middleware: maps `ApiError` (and unknown errors) to `{ error: { message, code } }` + status; hides stack in production.

---

## 11. Controllers & routes

**`routes/auth.routes.js`**
```js
const r = require("express").Router();
// public
r.post("/register",        validate(registerSchema), h(auth.register));
r.post("/login",           authLimiter, validate(loginSchema), h(auth.login));
r.post("/google",          validate(googleSchema), h(auth.google));
r.post("/admin/login",     authLimiter, validate(loginSchema), h(adminAuth.login));
r.post("/refresh",         validate(refreshSchema), h(auth.refresh));
r.post("/forgot-password", authLimiter, validate(forgotSchema), h(auth.forgotPassword));
r.post("/reset-password",  validate(resetSchema), h(auth.resetPassword));
r.post("/verify-email",    validate(verifySchema), h(auth.verifyEmail));      // optional
// authenticated
r.get ("/me",              authenticate, h(auth.me));
r.patch("/profile",        authenticate, validate(updateProfileSchema), h(auth.updateProfile));
r.post("/change-password", authenticate, validate(changePwSchema), h(auth.changePassword)); // optional
r.post("/logout",          authenticate, h(auth.logout));
module.exports = r;
```

`routes/index.js` mounts it at `/auth`, and `app.js` mounts everything under `env.API_PREFIX` (`/api`) → final paths like `POST /api/auth/login`, matching the frontend's `NEXT_PUBLIC_API_URL=http://localhost:5000/api`.

Controllers are thin: validate is done by middleware, they call the service and `ok(res, data)`. Example:
```js
exports.login = asyncHandler(async (req, res) => {
  const result = await authService.loginLocal(req.body, req);   // { user, tokens }
  ok(res, result);   // -> { data: { user, tokens } }  ← exactly what the FE expects
});
```

---

## 12. Admin seeder (`seeders/admin.seeder.js`)

Runs on server boot (called from `server.js` after DB connect). **Idempotent**:

```js
module.exports = async function seedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = env;
  const existing = await User.scope("withPassword").findOne({ where: { email: ADMIN_EMAIL } });
  const password_hash = await password.hash(ADMIN_PASSWORD);

  if (!existing) {
    await User.create({ role: "admin", name: ADMIN_NAME, email: ADMIN_EMAIL,
      password_hash, auth_provider: "local", is_email_verified: 1, is_active: 1 });
    console.log(`✅ Seeded admin ${ADMIN_EMAIL}`);
  } else {
    // Re-hash only if the env password changed (compare against stored hash)
    const same = await password.compare(ADMIN_PASSWORD, existing.password_hash || "");
    if (!same) { existing.password_hash = password_hash; await existing.save();
      console.log("🔁 Admin password updated from .env"); }
  }
};
```

So the admin **id (email) + password live only in `.env`**; the DB stores a bcrypt hash. Rotating the admin password = change `.env` + restart.

---

## 13. `app.js` / `server.js` skeleton

**`app.js`**
```js
const app = express();
app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));
app.use(env.API_PREFIX, routes);          // /api/...
app.use(errorHandler);                     // must be last
module.exports = app;
```

**`server.js`**
```js
(async () => {
  await sequelize.authenticate();
  // await sequelize.sync();   // dev only, auth tables
  await seedAdmin();
  app.listen(env.PORT, () => console.log(`API on :${env.PORT}${env.API_PREFIX}`));
})();
```

---

## 14. Request/response examples (contract the frontend codes against)

**`POST /api/auth/login`** → `200`
```json
{ "data": {
  "user":   { "id": 12, "name": "Dr. Rao", "email": "rao@x.com", "role": "doctor", "avatarUrl": null },
  "tokens": { "accessToken": "eyJ...", "refreshToken": "9f2c..." }
}}
```

**`POST /api/auth/refresh`** → `200`
```json
{ "data": { "accessToken": "eyJ...", "refreshToken": "a71b..." } }
```
> Note: the frontend interceptor calls `tokenStorage.setTokens(data.data)`, so `refresh` returns the token pair **directly under `data`** (not nested in `tokens`). Keep that exact shape.

**`GET /api/auth/me`** → `200`
```json
{ "data": { "id": 12, "name": "Dr. Rao", "email": "rao@x.com", "role": "doctor", "avatarUrl": null } }
```

**Error** → `4xx`
```json
{ "error": { "message": "Invalid email or password", "code": "INVALID_CREDENTIALS" } }
```

---

## 15. Testing checklist

- [ ] Admin seed creates exactly one row; restart doesn't duplicate; password change in `.env` propagates.
- [ ] `admin/login` rejects doctor/patient creds; `login` rejects admin creds.
- [ ] Local register creates user + profile; duplicate email → 409; `password_hash` never in any response.
- [ ] Google new email → creates account with `role`; existing → logs in; missing `role` on new → 400.
- [ ] Refresh rotates; reusing an old refresh token revokes the whole family.
- [ ] Forgot-password returns 200 for unknown emails (no enumeration); reset link works once; reset kills existing sessions.
- [ ] `/me` and `/profile` require a valid access token; expired access → 401 → FE refreshes → replays.
- [ ] Rate limiter trips on repeated bad logins.
