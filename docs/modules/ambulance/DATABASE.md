# Ambulance — database (migration 040)

File: `backend/src/db/migrations/040_ambulance.sql`. **Additive only** — one enum value added to `users.role`,
five new tables. No existing table, column or row is changed or dropped; no `DROP` / `TRUNCATE` anywhere.
Every `CREATE` is `IF NOT EXISTS`, so the file is idempotent.

How it is applied:
- `npm run migrate` (tracked in `_migrations` as `040_ambulance.sql`), and
- on every boot by `db/ensureAmbulance.js`, which executes the same file's `CREATE TABLE IF NOT EXISTS`
  statements and widens `users.role` only if `'ambulance_provider'` is missing (runs after `ensureBloodBank`,
  so it is the guard that knows every role value).
- In development `sequelize.sync()` may create the tables first from the models, which mirror the SQL.

## `users.role`

`ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab','blood_bank','ambulance_provider')`

## Tables

### `ambulance_provider_profiles` — the operator organisation (1:1 with `users`)
PK = FK `user_id → users.id` (CASCADE). `organization_name`, `contact_person`, `phone`, `emergency_phone`,
`district`, `is_24x7`, `about`, `verification_status ENUM(pending,approved,rejected)`, `verification_notes`,
`verified_at`, `is_active`, timestamps. Index `idx_app_verification (verification_status, is_active)`.
Address + Google location stay on `users` (`address_line, city, state, pincode, lat, lng`).

### `ambulance_drivers` — a provider's drivers (no login)
`provider_id → users.id` (CASCADE), `name`, `phone`, `license_number`, `license_valid_until`,
`emergency_contact_name/phone`, `is_active`. Unique `uq_ad_provider_license (provider_id, license_number)`;
index `idx_ad_provider (provider_id, is_active)`.

### `ambulances` — one vehicle
`provider_id → users.id` (CASCADE), `registration_number` (**UNIQUE**), `vehicle_number` (**UNIQUE**, normalised
e.g. `OD02AB1234`), `ambulance_type VARCHAR(40)` (key of `config/ambulance.js`), `vehicle_model`,
`vehicle_details`, `capacity`, `equipment JSON`, `service_area`, `service_radius_km`, base location
(`base_address/city/state/pincode/lat/lng`), `is_emergency_available`, pricing (`base_fare`, `per_km_rate`,
`waiting_charge_per_hour`, `emergency_surcharge`), `default_driver_id → ambulance_drivers.id` (SET NULL),
`availability_status ENUM(available,on_trip,offline,maintenance)`, `verification_status`, `verification_notes`,
`verified_at`, `is_active`.
Indexes: `uq_amb_registration`, `uq_amb_vehicle`, `idx_amb_provider (provider_id, verification_status)`,
`idx_amb_public (verification_status, is_active, availability_status, ambulance_type)`,
`idx_amb_location (base_lat, base_lng)` (bounding-box pre-filter), `idx_amb_city (base_city, base_state)`.

### `ambulance_bookings` — a patient's booking
`booking_code` (**UNIQUE**, `AMB-YYYYMMDD-XXXXXX`), `patient_id → users.id`, `provider_id → users.id`,
`ambulance_id → ambulances.id` (all CASCADE), `driver_id → ambulance_drivers.id` (SET NULL), `ambulance_type`
(snapshot), `is_emergency`, `patient_name`, `contact_phone`, pickup + drop (`*_address/lat/lng`), `notes`,
fare **snapshot** (`estimated_distance_km`, `base_fare`, `per_km_rate`, `emergency_surcharge`,
`waiting_charge_per_hour`, `estimated_fare`), completion (`actual_distance_km`, `waiting_minutes`, `final_fare`),
`eta_minutes`, `status ENUM(requested,accepted,driver_assigned,en_route,arrived,patient_picked_up,completed,rejected,cancelled)`,
`provider_note`, `cancel_reason` (also the rejection reason), `cancelled_by ENUM(patient,provider,admin)`,
one `*_at` per status.
Indexes: `idx_ab_patient (patient_id, created_at)`, `idx_ab_provider (provider_id, status, created_at)`,
`idx_ab_ambulance (ambulance_id, status)`, `idx_ab_driver (driver_id, status)`, `idx_ab_status (status, created_at)`.

### `ambulance_booking_events` — status history (append-only)
`booking_id → ambulance_bookings.id` (CASCADE), `from_status`, `to_status`, `actor_user_id → users.id`
(SET NULL), `actor_role ENUM(patient,provider,admin)`, `note`, `created_at`. Index `idx_abe_booking (booking_id, created_at)`.
Written in the same transaction as every status change.

## Relationships

```
users (ambulance_provider) 1─1 ambulance_provider_profiles
users (ambulance_provider) 1─* ambulances ─*..1 ambulance_drivers (default driver)
users (ambulance_provider) 1─* ambulance_drivers
users (patient) 1─* ambulance_bookings *─1 ambulances, *─1 users (provider), *─0..1 ambulance_drivers
ambulance_bookings 1─* ambulance_booking_events
users 1─* medicine_notifications (existing; reference_type 'ambulance_*')
```

## Not created (on purpose)

`ambulance_types` (config), driver user accounts (records), GPS/location history (no real-time infra yet),
a counter table for booking codes (random suffix + UNIQUE backstop).
