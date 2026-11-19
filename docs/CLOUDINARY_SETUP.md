# Cloudinary file storage — setup, security model, migration

IHS stores every uploaded file through one backend service
(`backend/src/services/upload.service.js`). Cloudinary is a third driver behind
it, next to `local` (disk, the dev default) and `s3`. Switching is an env change.
No client, database column or API response shape changes.

---

## 1. What changes when you switch to Cloudinary

| Concern | Before (`local`) | With `STORAGE_DRIVER=cloudinary` |
|---|---|---|
| New uploads | `backend/uploads/<key>` | Cloudinary, `<CLOUDINARY_FOLDER>/<key>` |
| Stored in MySQL | `http://<api>/uploads/<key>` | `https://res.cloudinary.com/<cloud>/<image\|raw>/<upload\|authenticated>/v<n>/<folder>/<key>` (same columns) |
| Public images | `/uploads/...` | Cloudinary CDN, `c_limit,w_1600,f_auto,q_auto` |
| Private files | `/uploads/...`, an unguessable URL readable by anyone who had it | Cloudinary `authenticated` assets, sent to clients only as short-lived signed `/api/files/...` links |
| Old files | — | Keep working from disk. Migrate them with the script in §8 |

**No database migration is needed.** Every file column is `VARCHAR(500/512)`. A
Cloudinary URL is well under 300 characters, and it encodes everything needed to
find the asset again: cloud, resource type, delivery type, version and public_id.
Entity association, ownership and file name stay in the existing rows and keys.

---

## 2. Account setup

1. In the Cloudinary Console, open **Settings → API Keys** and copy the **Cloud name**, **API Key** and **API Secret**.
2. Use a separate root folder per environment, for example `ihs-dev`, `ihs-staging` and `ihs`, so dev uploads never mix with production.
3. Check these account settings:
   - **Strict transformations** (Settings → Security). If this is on, either allow the transformation `c_limit,w_1600,f_auto,q_auto`, or set `CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION=` (blank). Public images are then served untransformed.
   - **"Allow delivery of PDF and ZIP files"**. This does not matter here: documents are stored as `raw` and private files are read server-side through the signed download API.
   - **Max file size.** This depends on your plan (the free plan has been 10 MB per image/raw file). Keep `MAX_UPLOAD_MB` at or below it. A file over the plan limit gets a clean 422.
   - **Folder mode.** Public IDs include the path (`ihs/patient/12/records/...`). In *dynamic folder* accounts the Media Library may show them flat. Delivery and deletion are unaffected.
   - **Backups.** If your plan offers automatic backup (Settings → Upload), enable it.
4. **Compliance.** These need confirming on your side before any patient data moves:
   - where your account's data is hosted;
   - Cloudinary's Data Processing Addendum and terms;
   - your obligations under India's DPDP Act 2023 and any health-data rules that apply.

   Using Cloudinary does **not** by itself make IHS compliant.

---

## 3. Environment variables

Add these to `backend/.env` only. `backend/.env.example` lists them with no values.

| Variable | Required | Where | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | — | backend | `cloudinary` to store new uploads there |
| `CLOUDINARY_CLOUD_NAME` | when driver=cloudinary | **backend only** | |
| `CLOUDINARY_API_KEY` | when driver=cloudinary | **backend only** | |
| `CLOUDINARY_API_SECRET` | when driver=cloudinary | **backend only — secret** | Used only by the SDK, for signing. Never logged or returned |
| `CLOUDINARY_FOLDER` | no (default `ihs`) | backend | Root folder, one per environment |
| `CLOUDINARY_PUBLIC_IMAGE_TRANSFORMATION` | no | backend | Blank disables it |
| `CLOUDINARY_TIMEOUT_MS` | no (60000) | backend | |
| `FILE_URL_TTL_MINUTES` | no (60) | backend | Private links stay valid for TTL to 2×TTL |
| `PUBLIC_URL` | **yes, correct value** | backend | The API's public origin, e.g. `https://api.example.in`. Private links are built on it |

**Do not add any `CLOUDINARY_*` variable to `frontend-*/.env*`, `mobile-*/.env*`
or `eas.json`.** Clients never need them: there are no client-side uploads or
upload presets, and the API returns finished URLs. An audit of all 7 Next.js apps
and 4 Expo apps found no storage credentials in any of them.

If any credential is missing, the API refuses to boot and names the variable. It
never prints the value:

```
❌ Invalid environment configuration:
  • "CLOUDINARY_API_SECRET" is not allowed to be empty
```

If the credentials are present but wrong, the API still boots, logs
`❌ Cloudinary credentials were rejected or unreachable: …`, and uploads return
`502 STORAGE_UNAVAILABLE`. Nothing is written to the database.

Production: the server's `backend/.env` is never deployed by the pipeline
(Jenkinsfile), so add the variables there by hand. Then run `npm ci` (this adds
the `cloudinary` package) and restart pm2.

---

## 4. Local development

```bash
cd backend
npm install
# backend/.env
STORAGE_DRIVER=cloudinary
CLOUDINARY_CLOUD_NAME=<yours>
CLOUDINARY_API_KEY=<yours>
CLOUDINARY_API_SECRET=<yours>
CLOUDINARY_FOLDER=ihs-dev
PUBLIC_URL=http://localhost:5000      # the URL the browser/phone reaches the API on
npm run dev
# expect:  🗂  File storage driver: cloudinary
#          ☁️  Cloudinary reachable (cloud "<yours>", folder "ihs-dev")
```

Mobile apps on a device: `mediaUrl()` already rewrites `localhost` in returned
URLs to the device-reachable API origin, so `/api/files` links work unchanged.

---

## 5. Upload and download flow

```
client ──multipart──▶ existing endpoint (auth + role guard, multer type/size allowlist)
                         │
                         ▼
              upload.service.put()
                ├─ content check: bytes must match the name (PDF, DOCX/XLSX, DOC/XLS, bitmaps)
                ├─ key = <prefix>/<uuid>-<safe name>
                └─ cloudinaryStorage.put()
                     ├─ resource_type: image (bitmaps) | raw (PDF, Word, Excel, DICOM, text)
                     ├─ type: upload (public prefixes) | authenticated (everything else)
                     └─ verifies the returned public_id, type and byte count
                         │
              storeThen(): DB row written ── fails? ──▶ new asset discarded, old reference untouched
                         ▼
              MySQL keeps the canonical Cloudinary URL (inert for private assets)

client ◀── JSON response ── app "json replacer" (utils/fileUrlReplacer)
              ├─ private ref  → <PUBLIC_URL>/api/files/<signed token>/<name.ext>
              ├─ public image → CDN URL + f_auto/q_auto/size cap
              └─ anything else (pasted links, text) → unchanged

<img>/<iframe>/new tab ──▶ GET /api/files/<token>/<name>
              ├─ HMAC + expiry checked (404 forged, 403 FILE_LINK_EXPIRED)
              ├─ bytes read server-side: Cloudinary download API with a 2-minute signature
              └─ inline for images/PDF/txt/csv, attachment for Word/Excel/RTF/DICOM
```

The existing authenticated streaming endpoints are unchanged and now read from
Cloudinary through the same service:
- prescription PDFs;
- diagnostic prescriptions and reports;
- blood-request documents;
- consented doctor record access;
- pharmacy prescription requests.

---

## 6. Supported file types

The server-side allowlist is unchanged (`backend/src/middlewares/upload.js`); size is limited by `MAX_UPLOAD_MB`.

| Kind | Formats | Stored as | Browser |
|---|---|---|---|
| Images | PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC/HEIF, AVIF (**SVG refused**) | `image` | inline |
| PDF | `.pdf` | `raw` | inline |
| Word / text | `.doc`, `.docx`, `.odt`, `.rtf`, `.txt` | `raw` | `.txt` inline, others download |
| Spreadsheets | `.xls`, `.xlsx`, `.ods`, `.csv` | `raw` | `.csv` inline, others download |
| DICOM | `.dcm` | `raw` | download |

Per-feature limits still apply on top of this:
- photos, showcase, hero and medicine images must be images;
- payment QR must be PNG/JPEG/WebP, 2 MB max;
- letterhead assets must be PNG/JPEG.

Executables, HTML, SVG and scripts are refused (existing rule). New: a `.pdf`,
`.docx`/`.xlsx`/`.odt`/`.ods`, `.doc`/`.xls` or image whose bytes don't match is
refused with `422 UNSUPPORTED_FILE_TYPE` before anything is stored.

---

## 7. Private medical documents

**Public** (CDN): only these key prefixes (`backend/src/config/storage.js`):
- `doctor/<id>/photo|gallery|showcase|hero`
- `patient/<id>/photo`
- `payment-qr/<id>`
- `medicine/masters/<id>/images`

**Private** (`authenticated`): everything else, including unknown future prefixes:
- patient, clinic and admin-uploaded records (`patient/*/records`, `clinic/*/patients/*`, `admin/*/patients/*`);
- lab reports and diagnostic prescriptions (`diagnostic/...`);
- prescription PDFs (`prescriptions/<doctorId>`);
- pharmacy prescription requests (`prescription-requests/...`; older ones under `prescriptions/`);
- doctor certificates (`doctor/*/docs`);
- clinic verification documents (`clinics/*/documents`);
- blood-request documents (`blood/...`);
- letterhead, watermark and **signature** images (`prescription-assets/...`).

Access model:
- **Authorisation is unchanged and still lives in the existing routes.** Patient ownership, the doctor's booking gate, the record-access request + patient approval workflow, clinic and lab scoping and admin roles all decide *whether* a response contains a file at all. A signed link is minted only inside such an authorised response, and carries no more access than it did.
- **Guessing gets nothing.** A private Cloudinary URL returns 401 without a signature made with the API secret, which only the backend holds. A `/api/files` token is an HMAC over the exact stored reference and an expiry, made with a server-only key. Changing either byte or the reference gives a 404.
- **Short-lived.** Links expire after `FILE_URL_TTL_MINUTES` to 2× that (default 60–120 min). They are stable within that window, so the browser cache still works. An expired link returns `403 FILE_LINK_EXPIRED`; reloading the page fetches fresh links.
- **No bearer token is needed to open a link.** `<img>`, `<iframe>`, a new tab and the Expo in-app browser can't send one. Within its lifetime the link *is* the credential, so it behaves like a password-reset link: don't paste it into chats or tickets. It is redacted from access logs (`/files/[redacted]`).
- **Caching.** Private responses send `Cache-Control: private, max-age ≤ 600` and `nosniff`; shared caches never store them. Public images are cached by the Cloudinary CDN.
- **Transformations** are applied only to public images. Private files are never transformed or exposed through a public derived URL.
- **Old local files**: `/uploads/` now serves *public* prefixes only. Private legacy files (records, reports, Rx) are reachable only through signed links. Path tricks (`..`, `%2F`, `%5C`) are refused.

Limitations to know about:
- A link holder can open that one file until the link expires. Revoking a doctor's record access stops *new* links immediately; links already handed out keep working until they expire. Lower `FILE_URL_TTL_MINUTES` if that window is too long.
- Private files stream through the API, so they use API bandwidth. Public images don't.
- Cloudinary's own expiring delivery tokens (token-based authentication) are a paid add-on and are not required: private bytes are read with the download API's expiring signature, which is available on all plans. If that API is unavailable for the account, the backend falls back to a signed delivery URL. Both are server-side only.

---

## 8. Migrating existing files

Current inventory (dev DB `ihssss`, read-only run, 26 Oct 2026):
- **85** database references to **84** distinct local files;
- **29** of those are already missing on disk. They point at files from an older `:5055` test server or deleted files, and are reported, not fixable;
- **0** references inside JSON columns;
- **0** unreferenced files on disk.

Run the same inventory on each environment before migrating.

```bash
cd backend
# 0. Back up first: the DB and the uploads folder
mysqldump -u <user> -p <db> > ihs-before-cloudinary.sql
tar czf uploads-before-cloudinary.tgz uploads/

# 1. Inventory — read-only (the default)
node scripts/migrateUploadsToCloudinary.js
#    → storage-migration/runs/<id>/inventory.json + report.json

# 2. Upload + verify (no DB writes; resumable; --limit for a trial)
node scripts/migrateUploadsToCloudinary.js --upload --limit 5
node scripts/migrateUploadsToCloudinary.js --upload
#    Each file keeps its key (deterministic public_id, never duplicated) and is
#    verified by reading it BACK and comparing SHA-256. Progress: storage-migration/state.json

# 3. Switch references for verified files only
node scripts/migrateUploadsToCloudinary.js --apply
#    Writes storage-migration/runs/<id>/applied.json (the undo list) BEFORE
#    committing; only rows still holding the exact old URL are changed.

# 4. Check the portals: avatars, medicine images, records, reports, Rx PDFs.
```

Guarantees:
- No local file and no old reference is ever deleted.
- Failed or missing files keep their original reference and are listed under `failed` / `missingOnDisk`.
- Re-running any step is safe.
- Keep `backend/uploads/` after migrating, for three reasons:
  - it is your backup;
  - rows that could not be migrated still use it;
  - `/uploads` keeps serving legacy public images.

Retry Cloudinary deletions that failed earlier (they are queued in
`backend/storage-cleanup.jsonl` instead of failing user requests):

```bash
node scripts/migrateUploadsToCloudinary.js --cleanup
```

---

## 9. Backup and rollback

| Situation | Action |
|---|---|
| Stop sending new uploads to Cloudinary | Set `STORAGE_DRIVER=local` and restart. Keep the `CLOUDINARY_*` values set: files already in Cloudinary stay readable and deletable |
| Undo a migration `--apply` | `node scripts/migrateUploadsToCloudinary.js --rollback storage-migration/runs/<id>/applied.json` (local files were never removed) |
| Full restore | Restore the `mysqldump` and `uploads` archive from §8 step 0 |
| Remove the integration entirely | Revert the code. Rows written while on Cloudinary keep Cloudinary URLs; roll them back first, or keep the credentials so the reads still work |

`storage-migration/` and `storage-cleanup.jsonl` reference patient files, so they
are git-ignored. Keep them with your other operational backups.

---

## 10. Verifying with your account (manual checklist)

With the §4 settings:
1. Boot shows `☁️ Cloudinary reachable`.
2. Doctor portal: upload a profile photo.
   - DB `users.profile_photo_url` starts with `https://res.cloudinary.com/<cloud>/image/upload/`.
   - The avatar renders on the doctor and patient websites and in the Expo apps.
3. MR portal: add a medicine image. It shows in the patient app catalogue.
4. Patient website: upload a **PDF** and a **.docx** record.
   - The DB URL contains `/raw/authenticated/`.
   - Opening that DB URL directly in a browser gives **401**.
   - In the app, the PDF opens in the viewer and the .docx downloads.
5. Doctor (with an approved record-access request, or via a booking): the record opens. A doctor without access gets no link.
6. Finalize a prescription with a letterhead logo and signature. The PDF renders with both, and opens for doctor and patient.
7. Diagnostic lab app: upload a report. The patient sees it.
8. Wait past 2×TTL (or set `FILE_URL_TTL_MINUTES=1`): an old link returns 403, and reloading the page works.
9. Delete a gallery image. The asset is gone from the Media Library.

---

## 11. Tests performed (26 Oct 2026)

| Test | Result |
|---|---|
| `node --test test/storage/cloudinaryStorage.test.js` (16 tests, Cloudinary SDK faked in memory, no DB) | **16/16 pass** |
| Live, local driver, dev DB, GET only: patient's records return signed links | Served bytes = disk bytes (SHA-256); old `/uploads` URLs → 404; other patient sees none; no token → 401; public image → 200; forged link → 404 |
| Live, `STORAGE_DRIVER=cloudinary` with **invalid** credentials against the real Cloudinary API | Boot reports rejected credentials and keeps serving; upload → 502 `STORAGE_UNAVAILABLE`; DB unchanged; spoofed PNG → 422; secret absent from logs |
| Migration script, inventory mode on the dev DB | Works (figures in §8) |
| Existing DB-backed suites (`npm test`) | **Not run.** MySQL user `ihs_app` has no rights on `ihs_test` (failed identically before these changes). Grant `ALL ON ihs_test.*` then run `npm run test:db && npm test` |
| A real upload/download against your Cloudinary account | **Not run** (no credentials in this environment) — use §10 |

What the 16 automated tests cover:
- public image → CDN with optimisation;
- PDF and Word → private `raw`;
- spoofed bytes refused before storage;
- provider rejection → 422 and outage → 502;
- orphan discarded on DB failure;
- failed delete queued, not thrown;
- foreign cloud/folder/traversal URLs ignored;
- inline PDF with private no-store-in-shared-cache headers;
- Word as attachment;
- forged, swapped and expired tokens rejected;
- links stable within a window;
- JSON replacer rewrites only our private refs;
- legacy public files still served, legacy private files blocked at `/uploads` but readable via signed link;
- missing credentials → clear boot error with no secret.
