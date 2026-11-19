# Development Setup

Commands are taken from `backend/package.json`, `backend/README.md` and the code. Windows (Git Bash / PowerShell) and Linux/macOS behave the same except for shell syntax of inline environment variables.

## 1. Prerequisites

| Need | Detail |
|---|---|
| Node.js | 20 or newer (CI uses `node20`; 22 works - `fetch` is built in). No `engines` constraint is declared |
| npm | `npm ci` is used in CI/deploy; `npm install` locally |
| MySQL | A reachable MySQL with InnoDB and utf8mb4. You need rights to `CREATE DATABASE` (the migration runner creates `DB_NAME`) or an existing empty database with DDL rights |
| Chromium | `npm install` downloads Puppeteer's Chromium (unless `PUPPETEER_SKIP_DOWNLOAD=true`). Without it prescription PDFs fail (`PDF_RENDER_FAILED`); set `PDF_ENGINE=none` to disable rendering or `PUPPETEER_EXECUTABLE_PATH` to use a system browser |
| Optional | A Razorpay test account, a LiveKit project (or the open-source `livekit-server --dev`), a Cloudinary account, Twilio - none are required for local work |

## 2. First run

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

* `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`;
* `JWT_ACCESS_SECRET`: at least 32 characters; generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;
* `ADMIN_EMAIL`, `ADMIN_PASSWORD` (min 8): the seeded admin identity;
* `CLIENT_URL`: comma-separated list of your frontend origins (default example covers ports 3000-3007);
* leave `STORAGE_DRIVER=local`, Razorpay/LiveKit blank, `SMTP_HOST` blank (Ethereal preview inbox), `SMS_PROVIDER=none` or `mock`.

Create/upgrade the schema, then start:

```bash
npm run migrate      # base schema from ../docs/dbstruct.md + src/db/migrations/*.sql
npm run dev          # nodemon src/server.js  ->  http://localhost:5000/api
```

On a healthy boot you should see: `Database connection established`, `Models synced (development)`, `API listening on http://localhost:5000/api`, `File storage driver: local`, and the schedulers' start lines. Check `GET http://localhost:5000/api/health` -> `{"status":"ok"}` and open `http://localhost:5000/api/docs` (Swagger UI, enabled in development).

### Two ways to get a schema in development
1. `npm run migrate` (recommended; same as production).
2. Let `NODE_ENV=development` boot do it: `sequelize.sync()` creates missing tables from the models and the `ensure*` shims patch older ones. Prefer migrate: the generated `bookings.active_lock_key` and several foreign keys come from the SQL.

Note for the standalone repo: `migrate.js` needs `docs/dbstruct.md` (see [README.md](README.md) section 6). If you only have this documentation folder, copy it as the repo's `docs/`.

## 3. What happens on boot (development)
See [ARCHITECTURE.md](ARCHITECTURE.md) section 5. In short: connect -> guards -> `sync()` -> shims -> admin + lookup seeds -> listen -> Socket.IO -> schedulers -> PDF preflight. `nodemon` restarts on any change under `src/` or to `.env` (`nodemon.json`), so every restart re-runs seeds and guards (fast, idempotent).

## 4. Useful development behaviours

| Situation | Behaviour |
|---|---|
| No Razorpay keys, `NODE_ENV=development` | online bookings (including video) confirm immediately with a synthetic payment, so the whole flow is testable |
| No LiveKit keys | video token endpoints return `503 VIDEO_NOT_CONFIGURED`; set `LIVEKIT_URL=ws://127.0.0.1:7880` with a local `livekit-server --dev` (see `.env.example` comments) to try calls |
| No SMTP | mail goes to an Ethereal test account; the preview URL is printed to the console |
| Password-reset by SMS | `SMS_PROVIDER=mock` prints the code in the console (refused in production) |
| Rate limits | defaults are generous (`RATE_LIMIT_MAX=600`, reads 3000 per 15 min). If an end-to-end script hits 429, start a separate API instance with larger limits instead of editing `.env` (see the testing guide) |
| Slow SQL | statements over 500 ms are logged; `DB_SQL_LOG=true` logs everything |
| Local files | `./uploads` (git-ignored); public images are served at `/uploads/<key>`; private ones only through signed `/api/files` links |
| Swagger | `http://localhost:5000/api/docs`; raw JSON at `/api/docs.json` |
| Admin login | the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` at `POST /api/auth/admin/login` |
| Seeding fake data | none provided; create users through `POST /api/auth/register` (patient/doctor) and approve doctors from the admin portal or API |

## 5. Creating test accounts by API (examples)

```bash
curl -X POST http://localhost:5000/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Test Patient","email":"patient@example.test","password":"Passw0rdTest","role":"patient"}'
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"patient@example.test","password":"Passw0rdTest","audience":"patient"}'
```

The response is `{ success, message, data: { user, tokens: { accessToken, refreshToken } } }`. Send `Authorization: Bearer <accessToken>` on later calls. A new doctor must complete onboarding, submit, and be approved by the admin (`POST /api/admin/doctors/:id/verify`) before appearing in `GET /api/doctors`; `POST /api/admin/doctors` creates an already-approved doctor.

## 6. Conventions to follow when changing code
(From the project's `backend-conventions` skill and verified in the code.)

* Layering: route -> (limiter) -> `validate` -> `authenticate` -> `authorize` -> controller -> service -> model; no logic in controllers, no queries in controllers.
* Validation only in `validators/` (Joi). Add vocabularies to `config/constants.js` and import them.
* Never return raw model instances; add or extend a serializer in `utils/serializers.js`.
* No queries inside loops: eager-load with `include`, batch with `IN (...)`, aggregate in SQL.
* Ownership as `WHERE`; compare ids through `utils/ids.sameId` when one side comes from the JWT.
* Use transactions for multi-row writes; never call an external service inside a transaction.
* No `process.env` outside `config/env.js`.
* New table: model + association in `models/index.js` + numbered SQL migration + (if needed) `ensure*` guard wired in `server.js`.

## 7. IDE / debugging tips
* Start with `node --inspect src/server.js` for the debugger; `nodemon` is for convenience only.
* `utils/processDiagnostics` prints one JSON line when the process stops for any reason and a clear message when the port is already in use.
* Boot failures from config validation list every invalid variable at once.
