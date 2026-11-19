# Session Log

## 2026-09-22

### Patient Medicine UI Enhancement

- Existing functionality preserved (search, category / location / provider / in-stock filters, pagination, detail navigation — backend API untouched).
- Medicine cards restyled to the Patient Dashboard design system (MUI `Paper` + theme radius tokens, preview icon, name/generic, type/strength/category chips, separated price + stock badge, provider/location rows, "View Medicine" action).
- Search/filter toolbar styled (pill search field with `FiSearch`, labelled category/provider selects, location field with `FiMapPin`, "In stock only" checkbox).
- Provider information formatting fixed — type, provider name and location now render on separate rows (no more concatenated values).
- Price and stock separated (`₹744.00` price + green "11 in stock" / red "Out of stock" badge).
- Category shown by its real name from the backend.
- Responsive grid — 1 column mobile, 2 tablet, 3 desktop; controls wrap; sidebar untouched.

### Patient Prescription Share Button

- Added a "Share Prescription" button to each prescription card (`PrescriptionsView`).
- Existing View / Download PDF buttons preserved unchanged.
- Button navigates to the EXISTING share route `ROUTES.dashboard.sharePrescription` (`/dashboard/prescriptions/share`).
- The clicked prescription's ID is passed via `?prescriptionId=<id>`; the share page pre-fetches that prescription's PDF through the existing ownership-checked `/patient/prescriptions/:id/pdf` stream and pre-selects the file. It can still be replaced with a new upload.
- Existing provider-type selector, provider list, file upload and Notes fields preserved; only the UI was brought in line with the dashboard (labelled selects, provider checkbox cards, MUI file picker + notes, consistent submit button).
- Existing backend sharing system reused (same `POST /api/medicine/prescriptions` flow); no backend changes.

### Files changed

| File | Change |
|------|--------|
| `frontend-patient/src/features/prescriptions/components/PrescriptionsView.tsx` | Added "Share Prescription" button + router push to existing share page with `?prescriptionId=`; View/Download untouched |
| `frontend-patient/src/app/(dashboard)/dashboard/prescriptions/share/page.tsx` | MUI restyle of existing share page; pre-selection of the referenced prescription's PDF via the authed stream; all share business logic unchanged |
| `frontend-patient/src/app/(dashboard)/dashboard/medicines/page.tsx` | MUI restyle of the Medicine Store page to the dashboard design system; all filter/search/order behavior unchanged |

### Verification

- `npm run build` (frontend-patient): PASS — all routes compile, TypeScript green.
- `npm run lint`: no new errors from the files above beyond the repo-wide `err: any` convention already present.
- No backend changes. No new routes created. No duplicate components/APIs. No secrets/debug code.
### Global Category + Global Medicine Master + Provider Inventory + Location-based Sharing

Extends the existing medicine module (no new cart/order/notification/location systems).

- **Global categories** — `medicine_categories` is shared by every provider. `GET /medicine/categories` and `GET /medicine/my-categories` both return the global list (`?search=`, case-insensitive). `POST /medicine/my-categories` is find-or-create: an equivalent name (trimmed, whitespace-collapsed, compared upper-cased) returns the existing row (`200, created:false`) instead of a duplicate; new names return `201`. Providers can no longer delete categories (route removed); delete is admin-only (`DELETE /medicine/categories/:id`). Admin create no longer writes the invalid `provider_type='admin'`. Category id contract: INT → JSON number → zod `number | ""` → Joi `number`.
- **Global medicine master** — new `medicine_masters` table/model (migration 035). Identity = normalized `NAME|STRENGTH|TYPE` in `identity_key` (UNIQUE), so `Jerodol-SP` / `JERODOL-SP` are one medicine. `GET /medicine/masters?search=` (MR/Store) searches it case-insensitively and flags `inMyInventory`.
- **Provider inventory** — `medicine_store_medicines` stays each provider's own row (own price/stock/location) and now points at the master via `medicine_master_id`. `POST /medicine/my-medicines` takes `medicineMasterId` (existing medicine) or new-medicine details (reuses an existing identical master, never duplicates it); a provider already selling that master gets 409. `PUT /medicine/my-medicines/:id` only changes price/stock/location/image/active. The descriptive columns stay on the inventory row as a snapshot so existing order/prescription readers keep working.
- **Backfill** — `src/db/ensureMedicineMaster.js` (boot, all envs, idempotent, additive) created 3 masters from the 8 existing dev inventory rows and linked all 8. Nothing merged or deleted; provider 74's 3 duplicate "Zerodol Sp 500mg" rows and provider 76's 2 "Zerodol th max" rows now share one master each.
- **Patient medicine search** — `GET /medicine/browse` accepts `city`/`state` (the patient's Google selection) matched case-insensitively against the provider's registered `users.city/state`; returns public provider info (name, role, city, state) and only active providers' listings. The patient page's free-text location box is replaced by the existing `ShareLocationAutocomplete`.
- **Prescription sharing** — provider type "All" added (default); provider rows carry `role`. `POST /medicine/prescriptions` now re-validates every selected provider server-side against type AND the selected city/state; request `provider_type` comes from the provider's real role; requests + notifications are created in one transaction. Stale-response guard added on the share page.
- **Bug fixes** — (1) every ownership check compared the JWT `sub` string to numeric BIGINT ids with `!==` → always 403 (request detail/file/status/availability/order-from-prescription, order view/cancel/status, notification read/delete). Fixed via `utils/ids.sameId`. (2) `frontend-mr/src/config/env.ts` parsed `process.env` as an object, so the built MR app had NO Maps key (Google search on MR/Store registration silently fell back to plain text) — now mapped literally; the key is present in the build. (3) Frontend toasts read `data.message` instead of the backend's `data.error.message` — MR helper `utils/apiError.ts`, patient `utils/error.getErrorMessage`. (4) MR apiClient no longer hard-reloads `/login` on a 401 from the login/register/refresh endpoints. (5) `/dashboard` stats read the wrong response level (always 0). (6) Direct order and cancel are now transactional with row locks (server price/stock). (7) Medicine GET routes validated `req.body`; now `validateQuery`. (8) Migration 030 created camelCase `createdAt/updatedAt` on `medicine_categories` (model expects snake_case) — fixed (030 had not been applied anywhere).

### Files changed

| File | Change |
|------|--------|
| `backend/src/models/medicineMaster.model.js` (new) | Global medicine master |
| `backend/src/db/migrations/035_medicine_master.sql` (new) | `medicine_masters` + `medicine_store_medicines.medicine_master_id` (FK, indexes) |
| `backend/src/db/ensureMedicineMaster.js` (new) + `server.js` | Idempotent schema guard + additive backfill at boot |
| `backend/src/db/migrations/030_medicine_mr.sql` | snake_case timestamps on `medicine_categories` |
| `backend/src/utils/ids.js`, `utils/medicineIdentity.js` (new) | `sameId`; shared normalization / identity key |
| `backend/src/models/index.js`, `medicineStoreMedicine.model.js`, `medicineCategory.model.js` | Master associations, `medicineMasterId`, global-category docs |
| `backend/src/services/medicineStore.service.js` | Global categories, master search/resolve, inventory create/update, structured-location browse/providers |
| `backend/src/services/prescriptionRequest.service.js` | Location/type re-validation, role-derived provider_type, transactional share, `sameId` |
| `backend/src/services/medicineOrder.service.js`, `medicineNotification.service.js` | Transactional order/cancel, `sameId` |
| `backend/src/validators|controllers|routes/medicineStore.*`, `prescriptionRequest.*` | New/changed request shapes, `/masters`, admin-only delete, `validateQuery` |
| `backend/src/config/swagger.js` | Medicine endpoints documented |
| `frontend-mr/src/app/(dashboard)/medicines/new/page.tsx` | "Search Existing Medicine" + "Add New Medicine" |
| `frontend-mr/src/app/(dashboard)/medicines/[id]/edit/page.tsx` | Shared fields read-only; only price/stock/location sent |
| `frontend-mr/src/app/(dashboard)/categories/page.tsx`, `categories/new/page.tsx` | Global list + search, no delete; find-or-create feedback |
| `frontend-mr/src/config/env.ts`, `utils/apiClient.ts`, `utils/apiError.ts` (new), `services/medicine.service.ts`, `config/api.ts`, `types/index.ts` | Env inlining, 401 handling, error messages, master/category APIs |
| `frontend-mr/src/app/(auth)/login|register/page.tsx`, `app/dashboard/page.tsx` | Real error messages; stats response shape |
| `frontend-patient/src/app/(dashboard)/dashboard/medicines/page.tsx`, `medicines/[id]/page.tsx` | Google location filter (existing component); provider city shown |
| `frontend-patient/src/app/(dashboard)/dashboard/prescriptions/share/page.tsx` | "All" type, role labels, city/state sent, stale-response guard |
| `frontend-patient/src/features/medicine/services/medicine.service.ts`, `types/index.ts` | city/state params, provider/master fields |

### Verification

- API end-to-end against the dev backend + DB: 62/62 checks passed (two runs) — categories, masters, inventory ownership, patient search/location, direct order, provider list by location/type, share validation, share recipients, availability on own inventory, order-from-prescription, notifications. Share success path ran in-process with only storage `put` stubbed (no S3 write).
- MR/Store registration with structured location → login → dashboard APIs: 201/200 for both roles.
- `npm run build`: frontend-mr PASS, frontend-patient PASS. ESLint on touched files: clean (one pre-existing `any` in patient `medicine.service.ts` line 29).
- NOT run: in-browser UI testing (no browser tooling this session).

## 2026-09-23

### Debug / fix pass — public Medicine 404, request UI + dates, MR deactivation

**Root causes found**

- **`/medicines` returned 404** — the public site is `frontend-patient` (port 3000). The previous phase added the navbar/footer links and `ROUTES.medicines|medicineDetail|cart|checkout|pharmacies|dashboard.orderInvoice`, plus the shared `MedicineBrowse` component and `useCart` hook, but was interrupted before any page file was created, so none of those routes existed. Backend APIs were fine.
- **Patient medicine pages looked like plain text** — the requests list, request detail, orders list, order detail and medicine detail pages were written with Tailwind classes, but the patient app is MUI-only (Tailwind is not installed), so every class was silently ignored.
- **MR still active** — the backend already used `ACTIVE_MEDICINE_PROVIDER_ROLES` everywhere, but the frontends did not: the pharmacy registration page defaulted to `mr` (which the backend now rejects) and had no Pharmacy Hospital option; the share page and dashboard medicine filter still offered "Medicine Representative".
- **Patient build was broken** (4 TS errors) — `getMyOrders`/`getOrder` now return order groups; the orders pages still read single order lines. The medicine-detail and prescription-detail order forms sent no `paymentMethod` (and an optional address) → every order from the UI would 422.
- **Backend edits were not live** — port 5000 was held by a stale plain `node src/server.js` from an earlier session, so `nodemon` could not bind. Stopped it; `nodemon` now serves 5000.

**Fixes**

- New routes (thin wrappers over existing components/APIs): `/medicines`, `/medicines/[id]`, `/cart`, `/checkout`, `/pharmacies`, `/dashboard/orders/[id]/invoice`. `/dashboard/medicines` and `/dashboard/medicines/[id]` now render the same shared `MedicineBrowse` / `MedicineDetail` (duplicate page code with the MR filter removed). `MedicineBrowse` takes a string `basePath` (a function prop cannot cross the server→client boundary — this crashed the page when first rendered).
- Login before add-to-cart: logged-out "Add to cart" → existing `/login?redirect=<medicine>?addToCart=<qty>` → the medicine page completes the add once signed in, then drops the flag.
- Checkout uses the existing server cart + `/medicine/orders/checkout` (COD or simulated UPI); simulated payment is settled from the order page via the existing `/groups/:id/pay`. Bill page renders `/groups/:id/invoice` (no tax added).
- Patient order pages read order groups, with an Order Placed → Confirmed → Preparing → Out for Delivery → On the Way → Delivered stepper, cancel, bill link.
- Prescription request detail: MUI; "Add selected to cart" (existing `/prescriptions/:id/cart`) replaces the broken inline order form.
- Patient Prescription Requests: MUI cards — date (dd MMM yyyy, time secondary) top-left, status badge top-right, Request #, provider + provider-type chip, file, "View status"; status tabs + date filter.
- Pharmacy Prescription Requests: existing design kept; date moved to the top-left of each card; date filter under the unchanged status tabs.
- Date filter: `from`/`to` (ISO) added to the EXISTING `GET /medicine/prescriptions/my-requests` and `/provider-requests` (validator + `createdAtRange` in `prescriptionRequest.service.js`). The client sends local-day boundaries, so "Today" is the user's IST day; paging/totals stay correct. Shared `DateRangeFilter` (All dates / Today / Last 7 days / Last 30 days / Custom) in each app's `components/forms`.
- Provider types: pharmacy registration offers only "Pharmacy Medicine Store / Clinic" and "Pharmacy Hospital"; `ProviderType`/`UserRole` include `pharmacy_hospital`; role labels via `roleLabel`; share page and filters use `ACTIVE_PROVIDER_TYPES` + `providerTypeLabel`. MR stays in the types only for existing accounts/rows — no data changed, no table touched.
- Pharmacy orders page: `on_the_way` step added (mirrors backend `MEDICINE_ORDER_TRANSITIONS`) and lifecycle labels.
- Footer "Medicine stores" (was "SOON") → `/pharmacies`.

**Verification (actually run)**

- API against the live dev backend (tokens minted in-process for existing users; nothing written): 16/16 — public browse without login, no MR rows, `providerType=mr` → empty, providers list active types only with labels, cart 401 logged out, register validator rejects `mr` / accepts both pharmacy types, date filter (that day 8/8, future 0, inverted range 422), pharmacy date + status filter scoped to own requests, order groups, invoice.
- Headless Chrome (Puppeteer) walkthrough: 18/18 — home navbar "Medicine" → `/medicines` (no 404); "Jerodol-SP" search shows separate provider rows (₹250 store / ₹270 hospital, type, Bhubaneswar, stock); public detail; logged-out Add to cart → login with redirect; `/pharmacies`; patient requests cards + "Today" filter (10 → 8 cards, all 23 Sep 2026); share page provider types = All / Store-Clinic / Hospital; patient orders, dashboard medicines, cart render; pharmacy register (no MR); pharmacy `/prescriptions` tabs + date filter + dated cards; pharmacy orders lifecycle tabs; no uncaught page errors.
- `npm run build`: frontend-patient PASS, frontend-mr PASS. `tsc --noEmit`: both clean. ESLint on touched patient files: clean; frontend-mr: 2 pre-existing findings (`set-state-in-effect` in the existing fetch-in-effect of prescriptions page and in `AuthProvider`).
- NOT run end-to-end: placing a real order / simulated payment / pharmacy status updates in the UI (would write orders to the DB) — the underlying APIs were verified in the previous phase's E2E run.

**Remaining**

- Dev DB contains QA/Test providers and medicines created by earlier test runs ("QA … 00391911", "Test Store …"); left untouched (no deletes).
- Home-page map hero still shows its pharmacy category as "coming soon" (map pins for pharmacies not wired); footer "Hospitals" / "Diagnostic labs" remain SOON by design.

## 2026-09-24

### UI/UX + responsive + hero + medicine images/substitutes + admin pharmacy tracking

- **Medicine images** — new `medicine_master_images` (migration 037 + boot guard `ensureMedicineMedia`), max 4 per GLOBAL medicine, stored via the existing `upload.service` (local/S3, no new storage). `POST/DELETE/PUT order /medicine/masters/:id/images…`; only admin or a pharmacy that sells the medicine may add/reorder, only uploader/admin may delete. `/browse` adds `primaryImageUrl`; `/medicine/:id` adds `images[]`.
- **Substitutes** — new `medicine_master_substitutes` (directional self-M:N between existing masters, never copies). `PUT /medicine/masters/:id/substitutes` (replace-the-set). Detail returns each substitute's real cheapest listing price, provider/in-stock counts, `available`, and `listingId` (null = nobody active sells it → "Not available", no link). Legacy MR listings excluded.
- **Pharmacy app** — Add/Edit Medicine: image slots with previews (upload after save on New; immediate on Edit, "make primary", remove), substitute picker over the existing master search. Prescription Requests → 3/2/1 card grid. Fixed literal `\u20B9` in the edit price label.
- **Patient app** — `HeroShowcase` (4 real-flow slides, Framer Motion fade/slide/scale + backdrop zoom, dots/prev/next/pause, pauses off-screen/hidden tab/hover, reduced-motion aware; optional background video from `NEXT_PUBLIC_HERO_MEDIA_URL`, gradient fallback when blank); map hero kept below it. `MedicineCard` (image, glass surface, hover zoom) in a container-aware grid capped at 4/row; `MedicineGallery` + `SubstituteList` on detail. Prescriptions / Requests / Orders → shared `CardGrid` (3/2/1). Share Prescription → 3-column desktop layout.
- **Admin** — `/admin/medicine/{overview,orders,inventory,pharmacies}` (admin-only, parameterized aggregate SQL) + "Pharmacy & Medicine" page and dashboard tiles.

### Verification

- API: 25/25 image/substitute checks (auth 401/403, self/unknown/limit validation, real substitute pricing, reorder, uploader-only delete) with storage stubbed; all test rows removed.
- Headless Chrome, 1920→375 (8 widths), all listed patient/public/pharmacy pages: 0 horizontal overflow; grids 3/2/1 as specified. Visual gallery+substitute check on real master 7 with temporary rows, reverted (substitutes 0, images 0 afterwards).
- Admin endpoints: admin 200, patient/pharmacy 403, anonymous 401.
- `next build`: patient, pharmacy, admin PASS. `tsc --noEmit` clean in all three. ESLint on touched files clean except pre-existing `set-state-in-effect` in pharmacy `medicines/page.tsx` and `prescriptions/page.tsx` fetch effects.
- No hero video files exist yet — the video path is untested with real media; the gradient fallback is what renders today.
