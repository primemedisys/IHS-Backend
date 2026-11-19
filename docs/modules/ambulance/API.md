# Ambulance — API

Base `/api`. Envelope: success `{ success, message, data }`; error `{ error: { message, code?, details? } }`
(422 `details` are keyed by field, dotted for nested signup fields, e.g. `ambulance.vehicleNumber`).
The full OpenAPI spec is served at `/api/docs` (tags *Ambulance Provider*, *Ambulance (public & patient)*, *Admin – Ambulances*).

Auth column: **Public** = no token · **Provider** = `ambulance_provider` token, any verification status ·
**Provider ✔** = approved + active provider (`requireApprovedAmbulanceProvider`, else 403 `ONBOARDING_INCOMPLETE`) ·
**Patient** = `patient` token · **Admin** = `admin` token.

## Auth

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/auth/ambulance/register` | Provider + first ambulance (+ optional driver), atomically; all `pending` | Public |
| POST | `/auth/ambulance/login` | Portal login (only `ambulance_provider`; others get 401). Rate-limited | Public |
| GET | `/auth/me`, POST `/auth/refresh`, `/auth/logout` | Existing | existing |

## Provider portal (`/ambulance`)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET / PUT | `/ambulance/profile` | Own profile + verification status / update | Provider |
| POST | `/ambulance/profile/resubmit` | Rejected → pending (409 otherwise) | Provider |
| GET | `/ambulance/reference` | Types, equipment, statuses, transitions | Provider |
| GET | `/ambulance/dashboard` | Fleet / driver / booking counts + open bookings | Provider ✔ |
| GET / POST | `/ambulance/ambulances` | List own (filters) / add (starts `pending`) | Provider ✔ |
| GET / PUT | `/ambulance/ambulances/:id` | View / edit (identity change → re-review) | Provider ✔ |
| PUT | `/ambulance/ambulances/:id/availability` | available / offline / maintenance (409 while on a trip) | Provider ✔ |
| PUT | `/ambulance/ambulances/:id/driver` | Default driver (or `null`) | Provider ✔ |
| GET / POST | `/ambulance/drivers` | List (with `currentTrip`) / add | Provider ✔ |
| GET / PUT | `/ambulance/drivers/:id` | View / edit / deactivate (409 `DRIVER_BUSY` on a trip) | Provider ✔ |
| GET | `/ambulance/bookings` | `?bucket=new|ongoing|completed|cancelled|open&status&ambulanceId&search&page&limit` | Provider ✔ |
| GET | `/ambulance/bookings/:id` | One booking + status history | Provider ✔ |
| POST | `/ambulance/bookings/:id/accept` | requested → accepted `{ etaMinutes?, note? }`; ambulance → `on_trip` | Provider ✔ |
| POST | `/ambulance/bookings/:id/reject` | requested → rejected `{ reason }` | Provider ✔ |
| POST | `/ambulance/bookings/:id/assign-driver` | accepted → driver_assigned, or reassign `{ driverId, etaMinutes? }` | Provider ✔ |
| POST | `/ambulance/bookings/:id/status` | en_route / arrived / patient_picked_up `{ status, etaMinutes?, note? }` | Provider ✔ |
| POST | `/ambulance/bookings/:id/complete` | → completed `{ actualDistanceKm?, waitingMinutes?, note? }`; server computes `finalFare`; ambulance freed | Provider ✔ |
| POST | `/ambulance/bookings/:id/cancel` | → cancelled `{ reason }` (until picked up) | Provider ✔ |

## Public discovery + patient bookings (`/ambulances`)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET | `/ambulances/reference` | Types (+ descriptions), equipment, statuses, flow | Public |
| GET | `/ambulances/nearby` | `?lat&lng` (required) `&radiusKm&ambulanceType&emergency&dropLat&dropLng&page&limit` — visible ambulances within both radii, available first, nearest first; `distanceKm`, `etaMinutes`, `estimate` | Public |
| GET | `/ambulances/:id` | One visible ambulance (`?lat&lng&dropLat&dropLng&emergency` add distance/fare); 404 otherwise | Public |
| GET | `/ambulances/:id/estimate` | `?pickupLat&pickupLng&dropLat&dropLng&emergency` — the booking's fare function | Public |
| POST | `/ambulances/bookings` | Create booking (status `requested`) | Patient |
| GET | `/ambulances/bookings` | Own bookings (`bucket`, `status`, paging) | Patient |
| GET | `/ambulances/bookings/:id` | Own booking + history (driver phone only while live) | Patient |
| POST | `/ambulances/bookings/:id/cancel` | `{ reason? }` — only requested / accepted / driver_assigned | Patient |

## Admin (`/admin`)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET | `/admin/ambulances/summary` | Providers / ambulances / bookings counts, by type, by status, 14-day trend | Admin |
| GET | `/admin/ambulance-providers` | Verification queue (`verificationStatus`, `search`, paging) | Admin |
| GET | `/admin/ambulance-providers/:id` | Provider + ambulances + drivers | Admin |
| POST | `/admin/ambulance-providers/:id/verify` | `{ decision: approved|rejected, notes (required if rejected), approvePendingAmbulances=true }` | Admin |
| PATCH | `/admin/ambulance-providers/:id/active` | Suspend / reinstate `{ isActive }` | Admin |
| GET | `/admin/ambulances` | All ambulances (verification, availability, type, provider, active, search) | Admin |
| GET | `/admin/ambulances/:id` | One ambulance | Admin |
| POST | `/admin/ambulances/:id/verify` | Approve / reject one ambulance | Admin |
| PATCH | `/admin/ambulances/:id/active` | Deactivate / reactivate | Admin |
| GET | `/admin/ambulance-bookings` | Monitoring ledger (`status`, `bucket`, `providerId`, `ambulanceId`, `from`, `to`, `search`) | Admin |
| GET | `/admin/ambulance-bookings/:id` | One booking + history | Admin |

## Notifications (existing endpoints)

`GET /medicine/notifications`, `/unread-count`, `PUT /:id/read`, `/read-all` — now also allowed for
`ambulance_provider`. Ambulance rows use `reference_type` `ambulance_booking` (patient + provider),
`ambulance` (provider: per-vehicle approval/deactivation) and `ambulance_provider` (provider verification).

## Error codes (new)

`VEHICLE_IN_USE` (409, registration/vehicle number taken), `AMBULANCE_UNAVAILABLE` (409), `OUTSIDE_SERVICE_AREA`
(422), `DRIVER_BUSY` (409). Existing codes reused: `VALIDATION_ERROR`, `ONBOARDING_INCOMPLETE`,
`INVALID_STATUS_TRANSITION`, `FORBIDDEN`, `NOT_FOUND`, `EMAIL_IN_USE`.
