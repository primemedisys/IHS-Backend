# Medicine Category 422 Fix — 2026-09-22

## Exact 422 Response

- **URL:** `POST http://localhost:5000/api/medicine/my-categories`
- **Status:** 422 Unprocessable Entity
- **Cause:** Joi validation failure — `slug` field required but not provided

## Request Payload

Frontend sends:
```json
{ "name": "ortho" }
```

No `slug` field included — the form only has a "Category Name" input.

## Root Cause

The Joi validation schema at `backend/src/validators/medicineStore.validator.js:60-63`:

```js
const createCategory = Joi.object({
  name: SAFE(150).required(),
  slug: SAFE(150).required(),    // ← REQUIRED, but frontend doesn't send it
});
```

The `slug` field was marked `.required()`, but the frontend form only collects `name`. The backend service (`medicineStore.service.js:132`) already auto-generates slug from name when slug is not provided:

```js
const safeSlug = (slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
```

The validation was the only thing blocking the request.

## Fix

**File:** `backend/src/validators/medicineStore.validator.js`

```diff
  const createCategory = Joi.object({
    name: SAFE(150).required(),
-   slug: SAFE(150).required(),
+   slug: SAFE(150).allow("", null),
  });
```

Made `slug` optional with `.allow("", null)`. The service auto-generates it from `name` when absent.

## Backend Fix Only

No database changes. No frontend changes needed.

## Validation Test Results

| Payload | Result |
|---------|--------|
| `{ name: "ortho" }` | PASS |
| `{ name: "ortho", slug: "ortho" }` | PASS |
| `{ name: "Dental Medicine", slug: "dental-medicine" }` | PASS |
| `{ name: "" }` | FAIL (name required — correct) |

## Category Creation Test

Service auto-generates slug from name:
- Input: `{ name: "ortho" }`
- Saved: `{ name: "ortho", slug: "ortho", providerId: <user.id>, providerType: "mr" }`

## Files Changed

| File | Change |
|------|--------|
| `backend/src/validators/medicineStore.validator.js` | `slug` field: `.required()` → `.allow("", null)` |
