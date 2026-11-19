# Prescription Request Schema Fix — 2026-09-22

## Original Error

```
SequelizeDatabaseError: ER_KEY_COLUMN_DOES_NOT_EXITS
Key column 'patientId' doesn't exist in table
```

**Failing SQL:**
```sql
ALTER TABLE `prescription_requests`
ADD INDEX `idx_pr_patient` (`patientId`)
```

**Triggered by:** `PrescriptionRequest.sync()` → `sequelize.sync()` → `server.js`

## Root Cause

The `PrescriptionRequest` model defined index `fields` using **camelCase** attribute names (`patientId`, `providerId`, `providerType`), but the project's Sequelize config uses `underscored: true` (in `backend/src/config/database.js:16`).

With `underscored: true`, Sequelize maps model attributes to snake_case database columns (`patientId` → `patient_id`). However, Sequelize does **NOT** apply `underscored` mapping to index `fields` — it passes them **literally** to SQL.

So `sync()` executed:
```sql
ADD INDEX `idx_pr_patient` (`patientId`)
```
But the actual database column is `patient_id`, not `patientId`.

The existing model `followUpStatus.model.js:30` demonstrates the correct convention:
```js
indexes: [{ unique: true, fields: ["doctor_id", "label"] }],  // snake_case
```

## Actual Database Schema

`DESCRIBE prescription_requests` (created by migration `032`):

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| `id` | `bigint unsigned` | NO | PRI |
| `patient_id` | `bigint unsigned` | NO | MUL |
| `provider_id` | `bigint unsigned` | NO | MUL |
| `provider_type` | `enum('mr','medicine_store')` | NO | |
| `file_url` | `varchar(512)` | NO | |
| `file_name` | `varchar(255)` | YES | |
| `notes` | `text` | YES | |
| `status` | `enum(...)` | NO | |
| `created_at` | `datetime` | NO | |
| `updated_at` | `datetime` | NO | |

All columns are **snake_case**. All three indexes from the migration exist.

## Model Schema (Before Fix)

```js
indexes: [
  { fields: ["patientId"], name: "idx_pr_patient" },           // ❌ camelCase
  { fields: ["providerId", "providerType"], name: "idx_pr_provider" },  // ❌ camelCase
  { fields: ["status"], name: "idx_pr_status" },               // ✅ no underscore needed
],
```

## Mismatch

| Index Name | Model `fields` | Actual DB Column |
|-----------|---------------|-----------------|
| `idx_pr_patient` | `patientId` | `patient_id` |
| `idx_pr_provider` | `providerId`, `providerType` | `provider_id`, `provider_type` |
| `idx_pr_status` | `status` | `status` (no change needed) |

## Fix

Changed index `fields` from camelCase to snake_case to match the actual database columns and the project's established convention:

```diff
  indexes: [
-   { fields: ["patientId"], name: "idx_pr_patient" },
-   { fields: ["providerId", "providerType"], name: "idx_pr_provider" },
+   { fields: ["patient_id"], name: "idx_pr_patient" },
+   { fields: ["provider_id", "provider_type"], name: "idx_pr_provider" },
    { fields: ["status"], name: "idx_pr_status" },
  ],
```

## Files Changed

| File | Change |
|------|--------|
| `backend/src/models/prescriptionRequest.model.js` | Index `fields` changed from camelCase to snake_case |

**No other files were changed.** No database drops, no destructive migrations.

## Database Changes

None. The migration `032` had already created the table with correct snake_case columns and indexes. The fix is purely in the Sequelize model definition so `sync()` no longer references non-existent column names.

## Data Safety

- `prescription_requests` had **0 rows** at time of fix
- `medicine_store_medicines` had **4 rows** — preserved
- `medicine_categories` had **0 rows** — preserved
- No data was deleted, modified, or lost

## Backend Startup Test

```
✅ Database connection established
🔄 Models synced (development)
🚀 API listening on http://localhost:...
```

No `ER_KEY_COLUMN_DOES_NOT_EXITS`. No other errors.

## Database Test

`SHOW INDEX FROM prescription_requests`:

| Key Name | Column Name |
|----------|------------|
| `PRIMARY` | `id` |
| `idx_pr_patient` | `patient_id` |
| `idx_pr_provider` | `provider_id` |
| `idx_pr_provider` | `provider_type` |
| `idx_pr_status` | `status` |

All indexes reference valid, existing database columns.

## Medicine Regression Test

No regression. The medicine system tables (`medicine_categories`, `medicine_store_medicines`, `medicine_orders`, `medicine_notifications`) are unaffected by this change. The `ensureCategoryProviderColumns.js` ensure function continues to work correctly.
