# Backend — Doctor–Patient Consultation Platform

Node.js + Express 5 + Sequelize 6 + MySQL (CommonJS). Conventions are enforced
by the `backend-conventions` skill in `.claude/skills/` — read it before adding code.

## Folder structure

```
backend/
├── .env                     # git-ignored — copy from .env.example
├── .env.example
└── src/
    ├── server.js            # entry: connect DB → (dev) sync → seed admin → listen
    ├── app.js               # express app: middleware, routes, error handler (no DB, no listen)
    ├── config/
    │   ├── env.js           # Joi-validated process.env → frozen `env` object
    │   ├── database.js      # the single Sequelize instance
    │   └── constants.js     # ROLES, AUTH_PROVIDERS, ERROR_CODES, BCRYPT_COST
    ├── models/              # Sequelize models; index.js wires associations
    ├── validators/          # Joi schemas, one per endpoint body
    ├── middlewares/         # validate, authenticate, authorize, rateLimiters, errorHandler
    ├── controllers/         # THIN: validated input → one service call → serialize → respond
    ├── services/            # all business logic + all DB access
    ├── utils/               # ApiError, apiResponse, asyncHandler, password, tokens, serializers
    ├── routes/              # route wiring; index.js mounts features under /api
    ├── templates/emails/    # HTML email templates
    ├── seeders/             # admin.seeder.js (idempotent)
    └── db/migrations/       # numbered SQL migrations (applied by `npm run migrate`)
```

## Request flow

```
route → rateLimiter? → validate(joiSchema) → authenticate? → authorize? → controller → service → model
```

Validation lives in `validators/` (run by the `validate` middleware), **not** in
controllers. Controllers are thin; all logic + DB access is in `services/`.

## Setup

```bash
cd backend
npm install
cp .env.example .env          # then fill in DB creds + a real JWT_ACCESS_SECRET
#   generate a secret: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# create / update the schema: applies docs/dbstruct.md (base schema) and every
#   src/db/migrations/*.sql in order, tracked in the `_migrations` table
#   (re-running is a no-op). Run it on every deploy, before restarting the API.
npm run migrate

npm run dev                   # nodemon on http://localhost:5000/api
```

`npm run seed:admin` upserts the admin from `.env` (also runs automatically on boot).

### Production

- Set `NODE_ENV=production` explicitly (the default is `development`, which enables
  dev-only behaviour such as `sequelize.sync()` and the no-gateway booking auto-confirm).
- Production refuses to boot with the `.env.example` placeholder `JWT_ACCESS_SECRET` /
  `ADMIN_PASSWORD`, and requires the Razorpay and LiveKit keys.
- Without SMTP settings, production sends **no** email (it logs an error) — set `SMTP_*`.
- API docs (`/api/docs`) are off in production unless `API_DOCS_ENABLED=true`.
- Run `npm start` (= `node src/server.js`) under pm2.

### File storage

`STORAGE_DRIVER` picks where NEW uploads go: `local` (dev default, `./uploads`),
`cloudinary` (recommended for production) or `s3`. Files stored under an earlier
driver keep working — reads and deletes follow the stored reference. Private files
(records, reports, prescriptions, certificates) are only ever sent to clients as
short-lived signed `/api/files/...` links. Setup, the security model, migrating
existing files and rollback: [`../CLOUDINARY_SETUP.md`](../CLOUDINARY_SETUP.md).
`node scripts/migrateUploadsToCloudinary.js` inventories local files (read-only by default).

### Tests

- `test/**` end-to-end suites can run against a running API: start one with test-sized
  rate limits, e.g. `PORT=5055 REMINDER_SCHEDULER_ENABLED=false RATE_LIMIT_MAX=100000
  AUTH_RATE_LIMIT_MAX=100000 SIGNUP_RATE_LIMIT_MAX=100000 FORGOT_PASSWORD_RATE_LIMIT_MAX=100000
  PDF_RATE_LIMIT_MAX=1000 node src/server.js`, then e.g.
  `RECORD_ACCESS_E2E_BASE_URL=http://localhost:5055 node --test test/recordAccess/recordAccess.test.js`
  (also `PAYMENT_`, `PHARMACY_`, `DIAGNOSTIC_E2E_BASE_URL`). They create `@ihs-test.example.com`
  accounts and deactivate them afterwards — never point them at production.
- The in-process suite (`npm run test:db && npm test`) needs a local `backend/.env.test`
  whose `DB_NAME` ends in `_test`, and a MySQL user with rights on that database.
- `node --test test/storage/cloudinaryStorage.test.js` needs no database: storage
  driver, signed file links and `/uploads` protection, with Cloudinary faked in memory.

## Response envelope

- Success: `{ "success": true, "message": "...", "data": <payload> }`
- Error:   `{ "error": { "message": "...", "code": "...", "details"?: {...} } }`
- `POST /api/auth/refresh` is the one exception — it returns `{ "data": { accessToken, refreshToken } }`
  directly, because the frontend axios interceptor reads the pair from `data.data`.

## Auth endpoints

Base: `/api/auth`. Public: `register`, `login`, `google`, `admin/login`, `refresh`,
`forgot-password`, `reset-password`. Authenticated (Bearer access token): `me`,
`profile` (PATCH), `change-password`, `logout`. See `docs/auth/` for the full design.
