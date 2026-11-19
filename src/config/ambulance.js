/**
 * Ambulance domain constants (migration 040). The ONE place ambulance types,
 * equipment, statuses, the booking state machine and the fare/ETA defaults are
 * defined — models, Joi validators, services and Swagger import from here, and
 * frontend-ambulance / frontend-patient / frontend-admin read them from
 * GET /ambulances/reference instead of hard-coding them.
 *
 * Ambulance types are CONFIGURATION (like BLOOD_COMPONENTS): stored as a
 * VARCHAR key, so adding a type here needs no migration.
 *
 * TRACKING HONESTY: nothing in this module reports a live vehicle position.
 * Distances are computed from the ambulance's registered BASE location and are
 * labelled as estimates; an ETA is either that estimate or a figure the
 * provider typed. Real-time GPS can be added later by writing to
 * ambulance_bookings (see docs/ambulance/ARCHITECTURE.md §Tracking).
 */

/** Add a type here to make it available everywhere (no migration needed). */
const AMBULANCE_TYPES = Object.freeze({
  emergency: { label: "Emergency Ambulance", description: "General emergency response and transport" },
  bls: { label: "Basic Life Support (BLS)", description: "Oxygen, first aid and basic monitoring" },
  als: { label: "Advanced Life Support (ALS)", description: "Cardiac monitor, defibrillator, paramedic on board" },
  patient_transport: { label: "Patient Transport", description: "Non-emergency transfers, discharge and check-ups" },
  neonatal: { label: "Neonatal / Baby Ambulance", description: "Incubator-equipped transport for newborns" },
  mortuary: { label: "Dead Body / Mortuary Transport", description: "Freezer-box transport of the deceased" },
  other: { label: "Other Specialised", description: "Any other specialised ambulance" },
});
const AMBULANCE_TYPE_KEYS = Object.freeze(Object.keys(AMBULANCE_TYPES));

/** Equipment a provider can tick. Free text goes in `vehicle_details`. */
const AMBULANCE_EQUIPMENT = Object.freeze({
  oxygen: "Oxygen cylinder",
  stretcher: "Stretcher",
  first_aid: "First-aid kit",
  wheelchair: "Wheelchair",
  suction: "Suction machine",
  cardiac_monitor: "Cardiac monitor",
  defibrillator: "Defibrillator (AED)",
  ventilator: "Ventilator",
  incubator: "Incubator",
  freezer_box: "Freezer box",
  paramedic: "Paramedic on board",
  ac: "Air-conditioned",
});
const AMBULANCE_EQUIPMENT_KEYS = Object.freeze(Object.keys(AMBULANCE_EQUIPMENT));

/** Same trio as clinic_profiles / blood_bank_profiles. Used by providers AND ambulances. */
const AMBULANCE_VERIFICATION = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

/**
 * ambulances.availability_status. `on_trip` is set and cleared by the booking
 * workflow; the provider sets the other three by hand.
 */
const AMBULANCE_AVAILABILITY = Object.freeze({
  AVAILABLE: "available",
  ON_TRIP: "on_trip",
  OFFLINE: "offline",
  MAINTENANCE: "maintenance",
});
/** What the provider may pick by hand (on_trip belongs to the booking workflow). */
const AMBULANCE_MANUAL_AVAILABILITY = Object.freeze([
  AMBULANCE_AVAILABILITY.AVAILABLE,
  AMBULANCE_AVAILABILITY.OFFLINE,
  AMBULANCE_AVAILABILITY.MAINTENANCE,
]);

/** ambulance_bookings.status — the booking lifecycle, in order. */
const AMBULANCE_BOOKING_STATUS = Object.freeze({
  REQUESTED: "requested",
  ACCEPTED: "accepted",
  DRIVER_ASSIGNED: "driver_assigned",
  EN_ROUTE: "en_route",
  ARRIVED: "arrived",
  PATIENT_PICKED_UP: "patient_picked_up",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});
const S = AMBULANCE_BOOKING_STATUS;

/** The happy path, in order — the patient timeline renders exactly this. */
const AMBULANCE_BOOKING_FLOW = Object.freeze([
  S.REQUESTED,
  S.ACCEPTED,
  S.DRIVER_ASSIGNED,
  S.EN_ROUTE,
  S.ARRIVED,
  S.PATIENT_PICKED_UP,
  S.COMPLETED,
]);

/**
 * The ONE provider transition table. accept / reject / assign-driver /
 * complete have their own endpoints (they carry extra data) but are checked
 * against THIS table too, so the UI's "next step" can never drift from what
 * the backend accepts.
 */
const AMBULANCE_PROVIDER_TRANSITIONS = Object.freeze({
  [S.REQUESTED]: [S.ACCEPTED, S.REJECTED, S.CANCELLED],
  [S.ACCEPTED]: [S.DRIVER_ASSIGNED, S.CANCELLED],
  [S.DRIVER_ASSIGNED]: [S.EN_ROUTE, S.CANCELLED],
  [S.EN_ROUTE]: [S.ARRIVED, S.CANCELLED],
  [S.ARRIVED]: [S.PATIENT_PICKED_UP, S.CANCELLED],
  [S.PATIENT_PICKED_UP]: [S.COMPLETED],
});

/** The simple "move to the next step" statuses (no extra payload needed). */
const AMBULANCE_PROGRESS_STATUSES = Object.freeze([S.EN_ROUTE, S.ARRIVED, S.PATIENT_PICKED_UP]);

/** A patient may cancel only before the ambulance has left. */
const AMBULANCE_PATIENT_CANCELLABLE = Object.freeze([S.REQUESTED, S.ACCEPTED, S.DRIVER_ASSIGNED]);

/** Bookings that hold the ambulance (it is `on_trip` while one exists). */
const AMBULANCE_ACTIVE_BOOKING = Object.freeze([
  S.ACCEPTED,
  S.DRIVER_ASSIGNED,
  S.EN_ROUTE,
  S.ARRIVED,
  S.PATIENT_PICKED_UP,
]);
/** Open = still needs someone to act (requested + active). */
const AMBULANCE_OPEN_BOOKING = Object.freeze([S.REQUESTED, ...AMBULANCE_ACTIVE_BOOKING]);
const AMBULANCE_CLOSED_BOOKING = Object.freeze([S.COMPLETED, S.REJECTED, S.CANCELLED]);

/** Who performed a booking status change (ambulance_booking_events.actor_role). */
const AMBULANCE_ACTOR = Object.freeze({
  PATIENT: "patient",
  PROVIDER: "provider",
  ADMIN: "admin",
});

/** The `<status>_at` column each status stamps. */
const AMBULANCE_STATUS_TIMESTAMP = Object.freeze({
  [S.ACCEPTED]: "acceptedAt",
  [S.DRIVER_ASSIGNED]: "driverAssignedAt",
  [S.EN_ROUTE]: "enRouteAt",
  [S.ARRIVED]: "arrivedAt",
  [S.PATIENT_PICKED_UP]: "pickedUpAt",
  [S.COMPLETED]: "completedAt",
  [S.REJECTED]: "rejectedAt",
  [S.CANCELLED]: "cancelledAt",
});

/**
 * Estimate defaults. The distance is great-circle × ROUTE_FACTOR (roads are
 * never straight); both it and the ETA are labelled "estimated" everywhere.
 * The provider may record the actual km on completion, which sets final_fare.
 */
const AMBULANCE_ESTIMATE = Object.freeze({
  ROUTE_FACTOR: 1.2,
  AVERAGE_SPEED_KMPH: 30,
  /** Search radius when the caller does not give one. */
  DEFAULT_RADIUS_KM: 25,
  MAX_RADIUS_KM: 200,
  /** An ambulance with no service radius set is treated as covering this much. */
  DEFAULT_SERVICE_RADIUS_KM: 25,
});

/** medicine_notifications.reference_type values used by this module (shared table). */
const AMBULANCE_NOTIFICATION_REF = Object.freeze({
  BOOKING: "ambulance_booking",
  PROVIDER: "ambulance_provider",
  AMBULANCE: "ambulance",
});

/** Patient-facing wording for each status (notifications + timeline). */
const AMBULANCE_STATUS_LABELS = Object.freeze({
  [S.REQUESTED]: "Ambulance requested",
  [S.ACCEPTED]: "Booking accepted",
  [S.DRIVER_ASSIGNED]: "Driver assigned",
  [S.EN_ROUTE]: "Ambulance en route",
  [S.ARRIVED]: "Ambulance arrived",
  [S.PATIENT_PICKED_UP]: "Patient picked up",
  [S.COMPLETED]: "Trip completed",
  [S.REJECTED]: "Booking declined",
  [S.CANCELLED]: "Booking cancelled",
});

/** Booking reference prefix: AMB-YYYYMMDD-XXXXXX. */
const AMBULANCE_BOOKING_PREFIX = "AMB";

module.exports = {
  AMBULANCE_TYPES,
  AMBULANCE_TYPE_KEYS,
  AMBULANCE_EQUIPMENT,
  AMBULANCE_EQUIPMENT_KEYS,
  AMBULANCE_VERIFICATION,
  AMBULANCE_AVAILABILITY,
  AMBULANCE_MANUAL_AVAILABILITY,
  AMBULANCE_BOOKING_STATUS,
  AMBULANCE_BOOKING_FLOW,
  AMBULANCE_PROVIDER_TRANSITIONS,
  AMBULANCE_PROGRESS_STATUSES,
  AMBULANCE_PATIENT_CANCELLABLE,
  AMBULANCE_ACTIVE_BOOKING,
  AMBULANCE_OPEN_BOOKING,
  AMBULANCE_CLOSED_BOOKING,
  AMBULANCE_ACTOR,
  AMBULANCE_STATUS_TIMESTAMP,
  AMBULANCE_ESTIMATE,
  AMBULANCE_NOTIFICATION_REF,
  AMBULANCE_STATUS_LABELS,
  AMBULANCE_BOOKING_PREFIX,
};
