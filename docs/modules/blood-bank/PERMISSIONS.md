# Permissions

Enforced on the **backend** (route role gate + service ownership scoping). Frontend guards are UX only.

| Actor | Can | Cannot |
|---|---|---|
| Blood bank, **pending / rejected** | sign in, read/update own profile, reference data, own notifications | any operational route (403 `ONBOARDING_INCOMPLETE`, rejection notes included); appear in patient search; receive requests |
| Blood bank, **suspended** (`is_active=false`) | sign in, profile | operations (403) ; patient search |
| Blood bank, **approved** | everything under `/blood-bank/*` for **its own** rows (`blood_bank_id = me`) | read or change another bank's donors, units, requests, camps, audit (404 — rows outside its scope don't exist for it); any `/medicine/*` route except notifications; any `/diagnostics/*`; any `/admin/*` |
| Patient | search approved banks, send requests, read/cancel **own** requests, stream **own** documents, camps, own history | another patient's request (404) or document (403); donor records; bank registers; unit details beyond the codes reserved/issued for them |
| Admin | verify / reject / suspend banks; read aggregate statistics, per-bank inventory counts and the request ledger (patient name + hospital, no documents) | reserve, cross-match, approve or issue anything; read supporting documents or donor details (no medical authority) |
| Pharmacy / Diagnostic lab / Doctor / Clinic | nothing in the blood module (403) | — |

Login portals are separate: `/auth/blood-bank/login` accepts only `blood_bank`; the medicine portal login does not accept it.

## Data minimisation

- `blood_requests.document_url` is never serialized; documents are streamed through the API with
  `Cache-Control: private, no-store` to the two participants only.
- Patients see a bank's public profile and **counts** of available units — never unit/donor details.
- Admin endpoints return aggregates and workflow status only.
- Donor records are private to the bank that registered them.

## Safety gates (business rules, backend)

| Action | Gate |
|---|---|
| Donation | donor `active`, has blood group, ELIGIBLE screening of the same donor ≤24 h before, screening unused |
| Test result | donation testing still `pending` |
| Testing decision | ≥1 result recorded; decided once |
| Release | unit in quarantine/testing, testing `passed`, not expired |
| Reserve | request open; unit `available`, `passed`, not expired, same component; ≤ units required; row lock |
| Cross-match | unit actively reserved for this request |
| Approve | request `reserved`; every active reservation's latest cross-match `compatible` |
| Issue | request `approved`; active reservation; unit `reserved`, not expired, `passed`; latest cross-match `compatible`; unit issued at most once (UNIQUE) |
| Patient cancel | status pending / viewed / processing / available |
