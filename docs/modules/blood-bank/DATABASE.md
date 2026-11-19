# Database

Migration **`backend/src/db/migrations/039_blood_bank.sql`** — additive only. Applied by `npm run migrate`
(tracked in `_migrations`) and, idempotently, on every boot by `db/ensureBloodBank.js`, which executes the
same `CREATE TABLE IF NOT EXISTS` statements read from the migration file (single source of truth).

## Changes to existing tables

| Table | Change |
|---|---|
| `users.role` | enum + `blood_bank` (all existing values kept) |

Nothing else existing is altered. (`uploaded_records` is not used — blood documents are request attachments, not medical records.)

## Reused tables

`users` (bank account + its Google location: `address_line, city, state, pincode, lat, lng`; patients),
`medicine_notifications` (all blood notifications), `_migrations`.

## New tables

| Table | Purpose | Key constraints |
|---|---|---|
| `blood_bank_profiles` | centre details + verification (PK = `user_id`) | FK users CASCADE; idx (verification_status, is_active) |
| `blood_counters` | gapless per-year reference numbers | PK (kind, year) |
| `blood_donors` | donors registered BY a bank | UNIQUE donor_code; FK bank; optional FK patient_user_id → users SET NULL |
| `blood_donor_screenings` | vitals + staff decision (deferrals live here) | FK donor CASCADE |
| `blood_camps` | donation camps | FK bank |
| `blood_camp_registrations` | patient sign-ups | UNIQUE (camp_id, patient_id) |
| `blood_donations` | one collection | UNIQUE donation_code; **UNIQUE screening_id** (one donation per screening) |
| `blood_tests` | lab results on the donation sample | FK donation CASCADE |
| `blood_units` | one traceable bag | UNIQUE unit_code; FK donation, donor, parent_unit_id (self, SET NULL); idx (bank, status, group, component), (bank, status, expires_at) |
| `blood_requests` | patient → bank request | UNIQUE request_code; FK patient, bank, referred_by_doctor_id (SET NULL); idx (bank, status, is_emergency) |
| `blood_reservations` | unit held for a request | FK request, unit |
| `blood_crossmatches` | recorded cross-match result | FK request, unit, reservation (SET NULL) |
| `blood_issues` | unit issued against a request | UNIQUE issue_code; **UNIQUE unit_id**; FK request, unit, reservation, crossmatch |
| `blood_audit_logs` | append-only trail | idx (bank, created_at), (entity_type, entity_id) |

## Deliberately NOT created (and why)

| Suggested | Decision |
|---|---|
| `blood_inventory` | Inventory is **derived** from `blood_units` (GROUP BY) — cannot drift or be faked. |
| `blood_components` | Components are configuration (`config/bloodBank.js`), stored as `VARCHAR(30)` so adding one needs no migration. |
| `blood_request_items` | A request is one group + component + N units. Multiple needs = multiple requests. |
| `blood_center_staff` | No IHS provider module has staff sub-accounts. Each action records the account (`users.id`) **and** the named staff member (`*_by_name`). Can be added later without changing these tables. |
| `donor_deferrals` | A deferral is a screening **decision** (+ reason / until) on `blood_donor_screenings`; the donor's `status`/`deferred_until` mirror the latest one. |

## Enumerations

Defined once in `config/bloodBank.js` and mirrored by the SQL enums:
blood groups `A+ A- B+ B- AB+ AB- O+ O-`; unit status `quarantine testing available reserved issued transferred processed discarded expired`;
request status `pending viewed processing available reserved approved rejected completed cancelled` (+ `is_emergency` flag);
reservation `active released issued`; cross-match `compatible incompatible`; testing `pending passed failed`;
screening decision `eligible deferred_temporary deferred_permanent`; donor status `active deferred_temporary deferred_permanent inactive`;
camp `scheduled completed cancelled`; camp registration `registered cancelled attended`.

Component default shelf life (days, from collection): whole_blood 35 · prbc 42 · platelets 5 · plasma 365.
A unit may be given a SHORTER expiry, never a longer one.

## Commands

```bash
cd backend
npm run migrate          # apply pending migrations to the DB in backend/.env
npm run test:db          # build the LOCAL test DB (backend/.env.test) — migrations + ensure guards + admin seed
npm run test:db:fresh    # drop and rebuild the local test DB
```
