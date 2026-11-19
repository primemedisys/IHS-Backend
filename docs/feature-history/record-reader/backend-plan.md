# Record reader — backend plan

🔵 Planned. **This is the short document on purpose: v1 needs no schema change, no new endpoint and
no serializer change.** Everything the reader reads is already reachable. What follows is the audit
that establishes that, plus the two small things worth doing anyway.

---

## 1. Where every document already comes from

| Kind | Source the page ALREADY has | Endpoint behind it |
|---|---|---|
| Report / X-ray / MRI / patient-uploaded Rx | `data.patient.uploadedRecords` on the appointment read | `GET /doctor/bookings/:id` 🟢 |
| Prescriptions the doctor wrote | `history.data.rows[].prescription.{id,rxNumber}` | `GET /doctor/bookings/:id/patient-timeline` 🟢 |
| The prescription PDF itself | fetched on demand as a blob | `GET /doctor/prescriptions/:id/pdf` 🟢 |

`PatientDescriptionView` already calls all three (`useAppointment`, `useTimelineByBooking`, `usePrescriptionPdf`; see `frontend-doctor/src/features/appointments/components/PatientDescriptionView.tsx`).
The reading list is a **merge of two arrays the page is already holding** — no fetch is added to open
the reader.

### 1.1 The access question, settled

`serializeTimelineRow` sets `canView = true` for **both** viewers
([`serializers.js:1488-1489`](../../../src/utils/serializers.js)):

```js
void viewer; // both viewers may open the PDF; kept for future policy splits
const canView = true;
```

So a doctor may open a prescription PDF, and `GET /doctor/prescriptions/:id/pdf` exists behind the
`authenticate + authorize('doctor') + resolveDoctorId('self')` guard
([`doctorPrescription.routes.js:69`](../../../src/routes/doctorPrescription.routes.js)).

> ⚠️ **One stale comment to fix while here.** `types/appointment.ts` and the timeline type still say
> *"`id` is null and `canView` false for a DOCTOR viewer — the PDF is patient-only"*. That has not
> been true since `canView` became unconditional. It is the kind of comment that makes the next
> person build a workaround for a restriction that does not exist. One-line doc fix, no behaviour.

### 1.2 The two file paths are NOT alike

This is the fact the frontend plan is built around:

| | Uploaded record | Prescription |
|---|---|---|
| URL | `fileUrl`, a **static** path under `/uploads` ([`app.js:61`](../../../src/app.js)) | none — an authenticated route |
| Fetch | the browser does it (`<img src>` / frame `src`) | `fetch` with the auth header → `Blob` → `URL.createObjectURL` |
| Cost of N | ~0 until scrolled into view | N requests + N object URLs to revoke |
| Cache | HTTP cache | React Query, `staleTime: Infinity` (`usePrescriptionPdf` (`frontend-doctor/src/features/prescriptions/hooks/usePrescription.ts`)) |

---

## 2. The two things worth doing anyway

### 2.1 🟡 Cache headers on `/uploads`

`express.static` already sets `ETag` and `Last-Modified`, so a re-read is a 304. Scrolling a long
record re-requests every image the browser has evicted, and an X-ray is measured in megabytes. An
explicit `maxAge` turns those into cache hits with no revalidation round-trip:

```js
express.static(env.UPLOAD_DIR, {
  // An uploaded record is immutable once written — the file is never edited in
  // place, only re-uploaded as a new row. A long cache is therefore safe, and
  // it is what makes scrolling back up through a year of scans instant.
  maxAge: "7d",
  immutable: true,
  …existing options
});
```

**Check before shipping:** confirm no code path overwrites a file at the same path. If any does,
drop `immutable` and keep `maxAge`.

### 2.2 🔵 (optional) `GET /doctor/bookings/:id/documents`

Only needed if the reader should show documents the *appointment snapshot* does not carry. Today
`uploadedRecords` is the patient's whole upload history, so v1 does not need it. Worth adding only
when one of these becomes true:

- the record grows past a few hundred documents and the snapshot needs paging;
- the reader wants documents from consultations with **other** doctors, which the snapshot excludes;
- prescriptions should arrive with their PDF URL pre-signed rather than fetched per item.

Shape, if it is ever built: `{ items: [{ id, kind, label, date, url|prescriptionId }] }`, newest
first, paged — i.e. exactly the reading list the frontend builds today, moved server-side.

---

## 3. What is NOT touched

`prescriptions`, `uploaded_records`, every migration, every service, every other serializer. The
reader is a reading surface over data the doctor is already authorised to see, through routes that
already enforce that authorisation per request. **No new access path means no new access rule.**
