-- ============================================================================
-- 040 — Ambulance module
--
-- Everything here is ADDITIVE: one enum value is added to users.role and new
-- ambulance_* tables are created. No existing column, row or table is changed.
--
-- Reused, not duplicated: users (the provider ACCOUNT, its address and Google
-- location from migration 034), medicine_notifications (in-app notifications,
-- shared by every provider module), the existing auth / token / role system.
--
-- Not created on purpose:
--   * ambulance_types     — types are configuration (config/ambulance.js),
--                           stored as VARCHAR so adding one needs no migration
--                           (the same decision as blood components, 039);
--   * driver user accounts — no provider module has staff sub-accounts; a
--                           driver is a record the provider manages;
--   * live GPS positions   — there is no real-time infrastructure yet. Every
--                           distance/ETA is an ESTIMATE from the ambulance's
--                           registered base location (see docs/ambulance).
--
-- Every CREATE is IF NOT EXISTS, so this file is idempotent on its own and is
-- also executed statement-by-statement by db/ensureAmbulance.js on boot.
-- ============================================================================

-- ── users.role += 'ambulance_provider' ──────────────────────────────────────
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role' AND COLUMN_TYPE LIKE '%ambulance_provider%');
SET @ddl := IF(@has = 0,
  "ALTER TABLE users MODIFY COLUMN role
     ENUM('patient','doctor','admin','clinic','mr','medicine_store','pharmacy_hospital','diagnostic_lab','blood_bank','ambulance_provider')
     NOT NULL DEFAULT 'patient'",
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- The provider / operator organisation. PK-is-the-FK on users.id, shaped after
-- blood_bank_profiles (same verification trio + is_active suspension).
CREATE TABLE IF NOT EXISTS ambulance_provider_profiles (
  user_id              BIGINT UNSIGNED NOT NULL,
  organization_name    VARCHAR(150)    NOT NULL,
  contact_person       VARCHAR(150)    NULL,
  phone                VARCHAR(20)     NULL,
  emergency_phone      VARCHAR(20)     NULL,
  district             VARCHAR(100)    NULL,
  is_24x7              TINYINT(1)      NOT NULL DEFAULT 0,
  about                VARCHAR(1000)   NULL,
  verification_status  ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  verification_notes   VARCHAR(500)    NULL,
  verified_at          DATETIME        NULL,
  is_active            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_app_verification (verification_status, is_active),
  CONSTRAINT fk_app_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Drivers are records owned by one provider (no login of their own).
CREATE TABLE IF NOT EXISTS ambulance_drivers (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id              BIGINT UNSIGNED NOT NULL,
  name                     VARCHAR(150)    NOT NULL,
  phone                    VARCHAR(20)     NOT NULL,
  license_number           VARCHAR(50)     NOT NULL,
  license_valid_until      DATE            NULL,
  emergency_contact_name   VARCHAR(150)    NULL,
  emergency_contact_phone  VARCHAR(20)     NULL,
  is_active                TINYINT(1)      NOT NULL DEFAULT 1,
  created_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ad_provider_license (provider_id, license_number),
  KEY idx_ad_provider (provider_id, is_active),
  CONSTRAINT fk_ad_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One vehicle. Publicly bookable ONLY when the provider AND this ambulance are
-- approved + active and availability_status = 'available'.
CREATE TABLE IF NOT EXISTS ambulances (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id            BIGINT UNSIGNED NOT NULL,
  registration_number    VARCHAR(30)     NOT NULL,
  vehicle_number         VARCHAR(20)     NOT NULL,
  ambulance_type         VARCHAR(40)     NOT NULL,
  vehicle_model          VARCHAR(100)    NULL,
  vehicle_details        VARCHAR(1000)   NULL,
  capacity               TINYINT UNSIGNED NULL,
  equipment              JSON            NULL,
  service_area           VARCHAR(255)    NULL,
  service_radius_km      SMALLINT UNSIGNED NULL,
  base_address           VARCHAR(255)    NULL,
  base_city              VARCHAR(100)    NULL,
  base_state             VARCHAR(100)    NULL,
  base_pincode           VARCHAR(20)     NULL,
  base_lat               DECIMAL(10,7)   NULL,
  base_lng               DECIMAL(10,7)   NULL,
  is_emergency_available TINYINT(1)      NOT NULL DEFAULT 1,
  base_fare              DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  per_km_rate            DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  waiting_charge_per_hour DECIMAL(10,2)  NULL,
  emergency_surcharge    DECIMAL(10,2)   NULL,
  default_driver_id      BIGINT UNSIGNED NULL,
  availability_status    ENUM('available','on_trip','offline','maintenance') NOT NULL DEFAULT 'available',
  verification_status    ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  verification_notes     VARCHAR(500)    NULL,
  verified_at            DATETIME        NULL,
  is_active              TINYINT(1)      NOT NULL DEFAULT 1,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_amb_registration (registration_number),
  UNIQUE KEY uq_amb_vehicle (vehicle_number),
  KEY idx_amb_provider (provider_id, verification_status),
  KEY idx_amb_public (verification_status, is_active, availability_status, ambulance_type),
  KEY idx_amb_location (base_lat, base_lng),
  KEY idx_amb_city (base_city, base_state),
  CONSTRAINT fk_amb_provider FOREIGN KEY (provider_id)       REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_amb_driver   FOREIGN KEY (default_driver_id) REFERENCES ambulance_drivers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A patient's booking of one ambulance. Fare inputs are SNAPSHOTS taken at
-- booking time, so a later price change never rewrites an existing booking.
CREATE TABLE IF NOT EXISTS ambulance_bookings (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_code           VARCHAR(24)     NOT NULL,
  patient_id             BIGINT UNSIGNED NOT NULL,
  provider_id            BIGINT UNSIGNED NOT NULL,
  ambulance_id           BIGINT UNSIGNED NOT NULL,
  driver_id              BIGINT UNSIGNED NULL,
  ambulance_type         VARCHAR(40)     NOT NULL,
  is_emergency           TINYINT(1)      NOT NULL DEFAULT 0,
  patient_name           VARCHAR(150)    NOT NULL,
  contact_phone          VARCHAR(20)     NOT NULL,
  pickup_address         VARCHAR(255)    NOT NULL,
  pickup_lat             DECIMAL(10,7)   NOT NULL,
  pickup_lng             DECIMAL(10,7)   NOT NULL,
  drop_address           VARCHAR(255)    NOT NULL,
  drop_lat               DECIMAL(10,7)   NOT NULL,
  drop_lng               DECIMAL(10,7)   NOT NULL,
  notes                  VARCHAR(1000)   NULL,
  estimated_distance_km  DECIMAL(8,2)    NOT NULL,
  base_fare              DECIMAL(10,2)   NOT NULL,
  per_km_rate            DECIMAL(10,2)   NOT NULL,
  emergency_surcharge    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  waiting_charge_per_hour DECIMAL(10,2)  NULL,
  estimated_fare         DECIMAL(10,2)   NOT NULL,
  actual_distance_km     DECIMAL(8,2)    NULL,
  waiting_minutes        SMALLINT UNSIGNED NULL,
  final_fare             DECIMAL(10,2)   NULL,
  eta_minutes            SMALLINT UNSIGNED NULL,
  status                 ENUM('requested','accepted','driver_assigned','en_route','arrived','patient_picked_up','completed','rejected','cancelled') NOT NULL DEFAULT 'requested',
  provider_note          VARCHAR(500)    NULL,
  cancel_reason          VARCHAR(500)    NULL,
  cancelled_by           ENUM('patient','provider','admin') NULL,
  accepted_at            DATETIME        NULL,
  driver_assigned_at     DATETIME        NULL,
  en_route_at            DATETIME        NULL,
  arrived_at             DATETIME        NULL,
  picked_up_at           DATETIME        NULL,
  completed_at           DATETIME        NULL,
  rejected_at            DATETIME        NULL,
  cancelled_at           DATETIME        NULL,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ab_code (booking_code),
  KEY idx_ab_patient (patient_id, created_at),
  KEY idx_ab_provider (provider_id, status, created_at),
  KEY idx_ab_ambulance (ambulance_id, status),
  KEY idx_ab_driver (driver_id, status),
  KEY idx_ab_status (status, created_at),
  CONSTRAINT fk_ab_patient   FOREIGN KEY (patient_id)   REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_ab_provider  FOREIGN KEY (provider_id)  REFERENCES users (id)             ON DELETE CASCADE,
  CONSTRAINT fk_ab_ambulance FOREIGN KEY (ambulance_id) REFERENCES ambulances (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ab_driver    FOREIGN KEY (driver_id)    REFERENCES ambulance_drivers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The status history (timeline + audit): one row per transition, written in
-- the SAME transaction as the status change.
CREATE TABLE IF NOT EXISTS ambulance_booking_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id      BIGINT UNSIGNED NOT NULL,
  from_status     VARCHAR(30)     NULL,
  to_status       VARCHAR(30)     NOT NULL,
  actor_user_id   BIGINT UNSIGNED NULL,
  actor_role      ENUM('patient','provider','admin') NOT NULL,
  note            VARCHAR(500)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_abe_booking (booking_id, created_at),
  CONSTRAINT fk_abe_booking FOREIGN KEY (booking_id)    REFERENCES ambulance_bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_abe_actor   FOREIGN KEY (actor_user_id) REFERENCES users (id)              ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
