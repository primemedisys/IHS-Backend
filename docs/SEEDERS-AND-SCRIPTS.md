# Seeders and Scripts

## 1. Seeders (`src/seeders/`)

All three are **idempotent and additive**, run automatically on **every boot** (in every environment) from `server.js`, and can also be run on their own (each ends with an `if (require.main === module)` block that opens the models, runs, closes the pool and exits non-zero on failure).

| Seeder | npm script | What it does |
|---|---|---|
| `admin.seeder.js` | `npm run seed:admin` | Upserts the admin user from `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Creates it (role `admin`, local provider, e-mail verified, active) when absent; when present it only re-hashes the password if the `.env` value no longer matches (`compare`), logging "Admin password updated from .env". The admin identity and password therefore live only in `.env`; the DB stores the bcrypt hash |
| `lookups.seeder.js` | `npm run seed:lookups` | Tops up the four dropdown vocabularies: `specializations` (with generated slug), `languages`, `allergies`, `conditions`. A name that already exists is skipped (case-insensitive), nothing is renamed or deleted, ids stay stable. Without it a fresh database shows "No options" on the doctor's Specialties step |
| `subSpecializations.seeder.js` | `npm run seed:sub-specializations` | Tops up sub-specializations per parent specialization (parent names must match the lookups seed; case-insensitive per-parent match; doctor-added rows from `POST /doctor/catalog/sub-specializations` are never removed) |

Order at boot: `seedAdmin` -> `seedLookups` -> `seedSubSpecializations` (sub-specializations depend on specializations).

What is **not** seeded: doctors, patients, clinics, providers, medicines (the global medicine master is built by pharmacies / admin), ICD codes (explicitly "nothing is seeded or invented" - every row comes from an administrator or an import), follow-up statuses (created per doctor on first use by `followUp.ensureSeeded`), prescription templates (auto-provisioned per doctor on first use by `resolveTemplate`).

## 2. Scripts

### `scripts/migrateUploadsToCloudinary.js`
Moves files stored by the local driver to Cloudinary: inventory (default) -> `--upload` -> `--apply` -> `--rollback <applied.json>` / `--cleanup`, `--limit <n>`. It `chdir`s to `backend/`, requires the real `config/env` and models, and discovers every `*_url` string column and every JSON/TEXT column across all models. Runbook and guarantees: [FILE-STORAGE-AND-UPLOADS.md](FILE-STORAGE-AND-UPLOADS.md) section 7. Writes only to `storage-migration/` (git-ignored) and, with `--apply`, to DB rows.

### Monorepo-level scripts that touch the backend (read-only references)
| File | Role |
|---|---|
| `scripts/deploy.sh <main|development>` | VPS deploy used by the GitHub workflow (git reset to origin, `npm ci`, `npm run migrate` for the backend, `pm2 restart`) |
| `ecosystem.config.js` | pm2 process definitions (`ihs-backend`, `ihs-dev-backend`) |
| `scripts/mobile-build-apk.ps1`, `scripts/mobile-docs/` | mobile build/doc tooling (not backend) |

### Test helpers
`test/setupTestDb.js` (`npm run test:db`, `test:db:fresh`) builds the local test database; `test/testEnv.js` loads `.env.test` and refuses any non-local or non-`*_test` database.

### Boot/diagnostic helpers
`utils/processDiagnostics.js` (`install`, `watchServer`) is wired from `server.js`; no standalone CLI.

## 3. What does not exist

There is no `backend/scripts/` data-seeding or backfill utility other than the Cloudinary migration; the former `scripts/_check_users.js` shown as deleted in the working tree is not part of the current tree. There is no cron configuration; recurring work is in-process (see [BACKGROUND-JOBS-AND-REALTIME.md](BACKGROUND-JOBS-AND-REALTIME.md)).
