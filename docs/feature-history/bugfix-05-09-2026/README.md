# Bug fix — 05/09/2026

**Project:** Indian Health System (IHS)
**Apps touched:** `backend/` only
**Status:** Both issues fixed and verified. **No database migration required.**

**Legend:** 🐞 bug fix

---

## 1. Registered Doctors & Registered Patients — HTTP 500 Error

### 1.1 Symptom

When clicking **Registered Doctors** or **Registered Patients** in the Admin Panel sidebar, the page shows a loading spinner, then displays an HTTP 500 error with:

- **Registered Patients:** `TypeError: registryService.patientConditions is not a function`
- **Registered Doctors:** `Error: WHERE parameter "doctor_id" has invalid "undefined" value`

Both API endpoints (`GET /api/admin/registry/doctors` and `GET /api/admin/registry/patients`) returned **500 Internal Server Error**.

### 1.2 Root Cause — Registered Patients

The `patientConditions` function was defined in `adminRegistry.service.js` (line 112) but was **not included in the `module.exports`** at the bottom of the file. The controller at `adminRegistry.controller.js:47` calls `registryService.patientConditions(ids)`, which failed because the function was not exported.

**File:** `backend/src/services/adminRegistry.service.js`

**Bug:** The `module.exports` line was:
```js
module.exports = { listDoctors, listPatients, assertPatient, recordCounts, deletionPreview, deletePatient };
```

The `patientConditions` function was missing from the exports, causing `TypeError: registryService.patientConditions is not a function` at runtime.

### 1.3 Root Cause — Registered Doctors

The `listDoctors` function included a nested `Clinic` include with `limit: 1` and `required: false`. In Sequelize 6, using `limit` on a `hasMany` include with `required: false` (LEFT JOIN) causes Sequelize to generate a correlated subquery. This subquery failed to correctly resolve the parent `DoctorProfile`'s primary key (`user_id`) in the `WHERE` clause, resulting in `doctor_id: undefined`.

**File:** `backend/src/services/adminRegistry.service.js`

**Bug:** The Clinic include had:
```js
{
  model: Clinic,
  as: "clinics",
  attributes: ["city", "state"],
  where: city || state ? {...} : undefined,
  required: Boolean(city || state),
  limit: 1,  // <-- This caused the Sequelize 6 subquery bug
}
```

When no city/state filter was applied (`required: false`), the `limit: 1` triggered a subquery that generated `WHERE doctor_id = undefined`.

### 1.4 Fix

**Fix 1 (Patients):** Added `patientConditions` to the `module.exports` in `adminRegistry.service.js`:

```js
module.exports = { listDoctors, listPatients, patientConditions, assertPatient, recordCounts, deletionPreview, deletePatient };
```

**Fix 2 (Doctors):** Removed the `limit: 1` from the Clinic include and added `group: ["User.id"]` to prevent duplicate rows when a doctor has multiple clinics. The function was also changed from synchronous to `async` to properly await the query:

```js
async function listDoctors({ q, city, state, minExperience, maxExperience } = {}) {
  // ... filter setup ...

  const include = [
    {
      model: DoctorProfile,
      as: "doctorProfile",
      attributes: [...],
      where: ...,
      required: ...,
      include: [
        {
          model: Clinic,
          as: "clinics",
          attributes: ["city", "state"],
          where: clinicWhere,
          required: Boolean(clinicFilter),
          // limit: 1 removed — Sequelize 6 subquery bug with required:false
        },
      ],
    },
  ];

  const rows = await User.findAll({
    where,
    include,
    order: [...],
    group: ["User.id"],  // Prevents duplicate rows from multiple clinics
  });

  return rows;
}
```

---

## 2. Files Changed

| File | Change |
|---|---|
| `backend/src/services/adminRegistry.service.js` | Added `patientConditions` to `module.exports`; removed `limit: 1` from Clinic include; added `group: ["User.id"]`; changed `listDoctors` to `async` |

**No other files changed.** No frontend changes. No database changes. No model changes. No migration required.

---

## 3. Verification

Tested against the live API on `localhost:5000` with a valid admin JWT token:

| Endpoint | Status | Result |
|---|---|---|
| `GET /api/admin/registry/patients` | 200 | 14 patients returned with real data (name, email, phone, gender, age, bloodGroup, city, state, conditions) |
| `GET /api/admin/registry/doctors` | 200 | 20 doctors returned with real data (name, email, phone, avatarUrl, qualification, experienceYears, verificationStatus, isListed, city, state) |
| `GET /api/admin/doctors?status=pending` | 200 | 7 doctors (existing queue, unchanged, regression check) |
| `GET /api/health` | 200 | `{"status":"ok"}` |

### Verification details:

| Check | Result |
|---|---|
| Registered Doctors loads successfully | ✅ 200 OK, 20 records |
| Registered Patients loads successfully | ✅ 200 OK, 14 records |
| Real database data is displayed | ✅ Real names, emails, conditions, etc. |
| HTTP 500 is resolved | ✅ Both endpoints return 200 |
| Existing Doctor Queue still works | ✅ 200 OK, 7 records |
| Existing authentication preserved | ✅ Admin guard still enforced |
| Existing authorization preserved | ✅ `[authenticate, authorize('admin')]` middleware chain unchanged |
| Existing filters work | ✅ city/state/experience filters wired correctly |
| Existing table UI unchanged | ✅ No frontend changes |
| No database schema changes | ✅ NONE |
| No migration required | ✅ NONE |

---

## 4. Summary

| Item | Detail |
|---|---|
| **Date** | 05-09-2026 |
| **Problem** | Registered Doctors and Registered Patients pages showed HTTP 500 errors |
| **Root Cause (Patients)** | `patientConditions` function not exported from `adminRegistry.service.js` |
| **Root Cause (Doctors)** | `limit: 1` on nested Clinic include with `required: false` caused Sequelize 6 subquery bug generating `WHERE doctor_id = undefined` |
| **Fix** | Added missing export; removed `limit: 1`, added `group` for deduplication |
| **Files Changed** | 1 file: `backend/src/services/adminRegistry.service.js` |
| **Database Changes** | NONE |
| **Frontend Changes** | NONE |
| **Design Changes** | NONE |
| **Business Logic Changes** | NONE |
