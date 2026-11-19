# Backend Plan — Multi-Clinic Booking

**Status: No backend changes.**

This feature is entirely a `frontend-patient` presentation/navigation rework. Every backend contract it needs already exists and is unchanged.

## Why nothing changes server-side

The rework only decides **where** the patient picks a clinic (moved from the profile section to the `/book` page). The data and endpoints behind clinic booking are identical before and after:

| Concern | Existing endpoint / shape | Change |
|---|---|---|
| Doctor + clinics + timings | `GET /doctors/:slug` → `serializePublicDoctor` (returns `clinics[]` with `days`, `openTime`, `closeTime`, `fee`, `address`, `phone`, `lat`, `lng`) | none |
| Free slots for a clinic/date | slots endpoint keyed on `{ doctorId, mode, clinicId, date }` | none |
| Create a booking | `POST /patient/bookings` `{ doctorId, mode, clinicId?, date, startTime, paymentMode }` (patient-role gated) | none |
| Payment verify | existing verify endpoint | none |

The clinic **timings** shown in the new `/book` chooser come from fields the doctor serializer **already** returns; no new columns, migrations, validators, serializers, or routes are required.

## If scope later grows (out of scope now)

- Per-clinic "next available" hints in the chooser would want a lightweight `GET /doctors/:id/clinics/next-available` (batch), to avoid N slot calls. Not needed for this change — the chooser fires no slot calls until a clinic is picked.
