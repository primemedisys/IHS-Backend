# Bug fixes 31/07/2026 — Backend

Server-side detail for the day's batch. Read `README.md` first for the *why*.

**Legend:** 🔵 new file · 🟡 modified · 🔴 removed

**No migration ships with this batch.** Every column touched already exists.

---

## 1. Editing an uploaded record

One new endpoint, threaded through all four layers in the order the conventions require:

```
route → validate(schema.updateRecord) → controller → service → model
```

### 1.1 `validators/patient.validator.js` 🟡 — `updateRecord`

```js
const updateRecord = Joi.object({
  fileType: Joi.string().valid("prescription", "lab_report", "other"),
  recordDate: Joi.date().iso().max("now").allow(null),
  tag: Joi.string().trim().max(100).allow("", null),
}).min(1);
```

Three decisions here:

- **No `fileUrl`, no `file`.** The stored document is immutable; replacing it is a new
  upload. Leaving `fileUrl` writable would let a row's file and its provenance diverge —
  a record chipped "uploaded by your clinic" could be silently repointed at another file.
- **`.min(1)`** mirrors `updateMedication`. An empty `PATCH` is a client bug, not a no-op,
  and returning `200` for it hides the bug.
- **`.max("now")`** matches `addRecord`/`uploadRecord`. A test cannot have happened
  tomorrow, and a stray future date would sort to the top of the timeline forever.

Note the deliberate difference from `uploadRecord`, which uses `.allow("", null)`: that
schema parses **multipart text fields**, where an untouched input arrives as `""`. `PATCH`
carries JSON, where "no date" is properly `null`, so `""` is not accepted. The frontend
sends `recordDate || null` for exactly this reason.

Exported alongside the existing schemas.

### 1.2 `services/patient.service.js` 🟡 — `updateRecord`

```js
async function updateRecord(userId, id, body) {
  const row = await UploadedRecord.findOne({
    where: { id, patientId: userId },
    include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
  });
  if (!row) throw ApiError.notFound("Record not found");
  if (row.source !== RECORD_SOURCES.PATIENT) {
    throw ApiError.forbidden("Only records you uploaded yourself can be edited");
  }
  await row.update(pickRecordMeta(body));
  return row;
}
```

**Scoped twice over.** `patientId: userId` in the `where` bounds the lookup to the caller's
own rows — another patient's id is a `404`, never a `403`, so the endpoint does not confirm
that someone else's record exists. The `source` check is the second gate (README §4.1).

**The `include` is load-bearing, not decoration.** `serializeUploadedRecord` emits the
author for the source chip. Without eager-loading `recordedBy`, the `PATCH` response would
carry `recordedBy: null` while `GET /records` carries the populated author — React Query
writes the mutation result into the cache, so the row would flip to "self-uploaded" until
the next refetch. Verified: the `PATCH` response now matches `GET` exactly.

`pickRecordMeta` is an explicit allow-list rather than a spread:

```js
function pickRecordMeta(body) {
  const out = {};
  if (body.fileType !== undefined) out.fileType = body.fileType;
  if (body.recordDate !== undefined) out.recordDate = body.recordDate || null;
  if (body.tag !== undefined) out.tag = body.tag || null;
  return out;
}
```

`undefined` checks (not truthiness) so an explicit `null` still clears a value, while an
absent key leaves the column untouched. Joi's `stripUnknown` already drops anything
unexpected; this is the second layer, so a future schema change cannot accidentally make
`patientId` or `source` writable.

### 1.3 `controllers/patient.controller.js` 🟡

```js
exports.updateRecord = asyncHandler(async (req, res) => {
  const row = await patientService.updateRecord(req.user.id, req.params.id, req.body);
  return ok(res, serializeUploadedRecord(row), "Record updated");
});
```

Three lines: one service call, one serializer, one envelope. No branching, no DB access.

### 1.4 `routes/patient.routes.js` 🟡

```js
router.patch("/records/:id", ...guard, validate(schema.updateRecord), patient.updateRecord);
```

Placed between the upload and delete routes. `PATCH` rather than `PUT` because the body is
a partial — `.min(1)` means one field is a complete request.

### 1.5 `config/swagger.js` 🟡

`patch` added to the existing `/patient/records/{id}` path, documenting `403` alongside
`404` and `422`, with the provenance restriction stated in the description.

---

## 2. What did **not** change, and why

### 2.1 No migration

`uploaded_records.record_date` (`DATEONLY`, nullable) has existed since the original
schema — `docs/dbstruct.md §16`. `source` and `recorded_by_user_id` came with migration
018. The day's work needed no new column, so this batch adds no `.sql` file and no
`ensure*` shim.

This is worth stating explicitly because the feature *reads* as a schema change ("add a
date to uploads"). It is not: the date was always storable, and the form simply never
collected it.

### 2.2 No backfill

`recordDate` stays nullable. `recordDateOf()` on the client falls back to `uploadedAt`, so
every pre-existing row keeps its current position on the timeline. Backfilling
`record_date = uploaded_at` would have been actively wrong — it would assert a test date
the system never actually knew.

### 2.3 `deleteRecord` untouched

Delete remains unrestricted by `source` (README §4.1). Changing it is a product decision.

### 2.4 The clinic write path

`services/clinicPatient.controller.js` and the clinic portal routes are untouched. A clinic
still uploads onto a patient's record via its own endpoint, stamped `source: 'clinic'` — the
new patient-facing `PATCH` simply refuses those rows.

---

## 3. Local database (development only)

No application code changed. `backend/.env` now points at local MySQL 8.0; the RDS block is
kept commented with the diagnosis attached. See README §1 and `integration-plan.md §3`.

Worth knowing for anyone booting a fresh local database: `server.js` runs `sequelize.sync()`
plus fourteen `ensure*` migrations when `NODE_ENV=development`, so the schema builds itself —
but **Sequelize never creates the database**. `CREATE DATABASE ihssss` has to happen first,
or boot fails with `ER_BAD_DB_ERROR` rather than anything self-explanatory.

---

## 4. Verification performed

Live API, registered patient, `curl`:

```
create without date       → 201  recordDate: null
PATCH {recordDate,fileType,tag} → 200  recordDate: "2026-06-15"
PATCH {recordDate:"2099-01-01"} → 422  (future date)
PATCH {}                        → 422  (min(1))
PATCH /records/999999           → 404  (not the caller's row)
PATCH a source='clinic' row     → 403  "Only records you uploaded yourself can be edited"
```

The `403` case was produced by flipping a real row to `source='clinic'` in SQL and
re-issuing the request as its owner. Test rows were deleted afterwards.

Module load check: `service.updateRecord`, `validator.updateRecord` and
`controller.updateRecord` all resolve, and `routes/patient.routes.js` + `config/swagger.js`
require cleanly.
