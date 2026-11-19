/**
 * Output shaping for the Ambulance module (migration 040). Nothing leaves the
 * API as a raw Sequelize instance; every client reads one of these shapes.
 *
 * `audience` decides what is visible:
 *   public   — discovery: no registration (RC) number, street address or verification notes
 *              (base lat/lng IS public — it positions the vehicle on the patient map);
 *   patient  — their own booking: the driver's contact only while the trip is live;
 *   provider — their own fleet / bookings: everything they entered + the patient contact;
 *   admin    — everything.
 */
const A = require("../config/ambulance");

const plain = (row) => (row && typeof row.toJSON === "function" ? row.toJSON() : row);
const str = (id) => (id == null ? null : String(id));
const numOrNull = (v) => (v == null ? null : Number(v));

function typeLabel(key) {
  return A.AMBULANCE_TYPES[key]?.label || key;
}

function equipmentList(keys) {
  return (Array.isArray(keys) ? keys : []).map((key) => ({ key, label: A.AMBULANCE_EQUIPMENT[key] || key }));
}

function serializeDriver(driver) {
  const d = plain(driver);
  if (!d) return null;
  return {
    id: str(d.id),
    name: d.name,
    phone: d.phone,
    licenseNumber: d.licenseNumber,
    licenseValidUntil: d.licenseValidUntil ?? null,
    emergencyContactName: d.emergencyContactName ?? null,
    emergencyContactPhone: d.emergencyContactPhone ?? null,
    isActive: Boolean(d.isActive),
    createdAt: d.createdAt,
  };
}

/** The provider summary shown next to an ambulance / booking. */
function providerSummary(user) {
  const u = plain(user);
  if (!u) return null;
  const p = u.ambulanceProviderProfile || {};
  return {
    id: str(u.id),
    name: p.organizationName || u.name,
    phone: u.phone ?? p.phone ?? null,
    emergencyPhone: p.emergencyPhone ?? null,
    is24x7: Boolean(p.is24x7),
    city: u.city ?? null,
    state: u.state ?? null,
  };
}

/**
 * @param {object} ambulance  Ambulance row (optionally with `provider`, `defaultDriver`)
 * @param {"public"|"provider"|"admin"} audience
 * @param {object} [extra]    computed fields (distanceKm, etaMinutes, estimate …)
 */
function serializeAmbulance(ambulance, audience = "public", extra = {}) {
  const a = plain(ambulance);
  if (!a) return null;
  const out = {
    id: str(a.id),
    providerId: str(a.providerId),
    ambulanceType: a.ambulanceType,
    typeLabel: typeLabel(a.ambulanceType),
    vehicleNumber: a.vehicleNumber,
    vehicleModel: a.vehicleModel ?? null,
    vehicleDetails: a.vehicleDetails ?? null,
    capacity: a.capacity ?? null,
    equipment: equipmentList(a.equipment),
    serviceArea: a.serviceArea ?? null,
    serviceRadiusKm: a.serviceRadiusKm ?? null,
    baseCity: a.baseCity ?? null,
    baseState: a.baseState ?? null,
    /** Registered base coordinates — the patient map places the vehicle marker here (no live GPS). */
    baseLat: numOrNull(a.baseLat),
    baseLng: numOrNull(a.baseLng),
    isEmergencyAvailable: Boolean(a.isEmergencyAvailable),
    pricing: {
      baseFare: numOrNull(a.baseFare),
      perKmRate: numOrNull(a.perKmRate),
      waitingChargePerHour: numOrNull(a.waitingChargePerHour),
      emergencySurcharge: numOrNull(a.emergencySurcharge),
    },
    availabilityStatus: a.availabilityStatus,
    isBookable: a.availabilityStatus === A.AMBULANCE_AVAILABILITY.AVAILABLE,
    provider: a.provider ? providerSummary(a.provider) : undefined,
    ...extra,
  };
  if (audience === "public") return out;
  return {
    ...out,
    registrationNumber: a.registrationNumber,
    baseAddress: a.baseAddress ?? null,
    basePincode: a.basePincode ?? null,
    defaultDriverId: str(a.defaultDriverId),
    defaultDriver: a.defaultDriver ? serializeDriver(a.defaultDriver) : null,
    verificationStatus: a.verificationStatus,
    verificationNotes: a.verificationNotes ?? null,
    verifiedAt: a.verifiedAt ?? null,
    isActive: Boolean(a.isActive),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** The provider's own / the admin's view of a provider account + organisation. */
function serializeProvider(user) {
  const u = plain(user);
  if (!u) return null;
  const p = u.ambulanceProviderProfile || {};
  return {
    id: str(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    addressLine: u.addressLine ?? null,
    city: u.city ?? null,
    state: u.state ?? null,
    pincode: u.pincode ?? null,
    lat: numOrNull(u.lat),
    lng: numOrNull(u.lng),
    organizationName: p.organizationName ?? u.name,
    contactPerson: p.contactPerson ?? null,
    emergencyPhone: p.emergencyPhone ?? null,
    district: p.district ?? null,
    is24x7: Boolean(p.is24x7),
    about: p.about ?? null,
    verificationStatus: p.verificationStatus ?? A.AMBULANCE_VERIFICATION.PENDING,
    verificationNotes: p.verificationNotes ?? null,
    verifiedAt: p.verifiedAt ?? null,
    isActive: Boolean(u.isActive) && p.isActive !== false,
    createdAt: u.createdAt,
  };
}

/** The driver's contact is shown to the patient only while the trip is live. */
const DRIVER_VISIBLE_TO_PATIENT = new Set([
  A.AMBULANCE_BOOKING_STATUS.DRIVER_ASSIGNED,
  A.AMBULANCE_BOOKING_STATUS.EN_ROUTE,
  A.AMBULANCE_BOOKING_STATUS.ARRIVED,
  A.AMBULANCE_BOOKING_STATUS.PATIENT_PICKED_UP,
]);

function serializeEvent(event) {
  const e = plain(event);
  return {
    id: str(e.id),
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus,
    label: A.AMBULANCE_STATUS_LABELS[e.toStatus] || e.toStatus,
    actorRole: e.actorRole,
    note: e.note ?? null,
    at: e.createdAt,
  };
}

/**
 * @param {object} booking  AmbulanceBooking with optional ambulance / provider / driver / patient / events
 * @param {"patient"|"provider"|"admin"} audience
 */
function serializeBooking(booking, audience) {
  const b = plain(booking);
  if (!b) return null;
  const driver = b.driver ? plain(b.driver) : null;
  let driverOut = null;
  if (driver) {
    driverOut =
      audience === "patient"
        ? { name: driver.name, phone: DRIVER_VISIBLE_TO_PATIENT.has(b.status) ? driver.phone : null }
        : { id: str(driver.id), name: driver.name, phone: driver.phone, licenseNumber: driver.licenseNumber };
  }
  const ambulance = b.ambulance ? plain(b.ambulance) : null;
  const out = {
    id: str(b.id),
    bookingCode: b.bookingCode,
    status: b.status,
    statusLabel: A.AMBULANCE_STATUS_LABELS[b.status] || b.status,
    ambulanceType: b.ambulanceType,
    typeLabel: typeLabel(b.ambulanceType),
    isEmergency: Boolean(b.isEmergency),
    patientName: b.patientName,
    contactPhone: b.contactPhone,
    pickup: { address: b.pickupAddress, lat: numOrNull(b.pickupLat), lng: numOrNull(b.pickupLng) },
    drop: { address: b.dropAddress, lat: numOrNull(b.dropLat), lng: numOrNull(b.dropLng) },
    notes: b.notes ?? null,
    fare: {
      estimatedDistanceKm: numOrNull(b.estimatedDistanceKm),
      baseFare: numOrNull(b.baseFare),
      perKmRate: numOrNull(b.perKmRate),
      emergencySurcharge: numOrNull(b.emergencySurcharge),
      waitingChargePerHour: numOrNull(b.waitingChargePerHour),
      estimatedFare: numOrNull(b.estimatedFare),
      actualDistanceKm: numOrNull(b.actualDistanceKm),
      waitingMinutes: b.waitingMinutes ?? null,
      finalFare: numOrNull(b.finalFare),
    },
    /** Minutes — the provider's figure when given, otherwise the booking-time estimate from base. */
    etaMinutes: b.etaMinutes ?? null,
    providerNote: b.providerNote ?? null,
    cancelReason: b.cancelReason ?? null,
    cancelledBy: b.cancelledBy ?? null,
    ambulance: ambulance
      ? {
          id: str(ambulance.id),
          vehicleNumber: ambulance.vehicleNumber,
          vehicleModel: ambulance.vehicleModel ?? null,
          ambulanceType: ambulance.ambulanceType,
          typeLabel: typeLabel(ambulance.ambulanceType),
          equipment: equipmentList(ambulance.equipment),
          baseCity: ambulance.baseCity ?? null,
        }
      : null,
    provider: b.provider ? providerSummary(b.provider) : null,
    driver: driverOut,
    timestamps: {
      requestedAt: b.createdAt,
      acceptedAt: b.acceptedAt ?? null,
      driverAssignedAt: b.driverAssignedAt ?? null,
      enRouteAt: b.enRouteAt ?? null,
      arrivedAt: b.arrivedAt ?? null,
      pickedUpAt: b.pickedUpAt ?? null,
      completedAt: b.completedAt ?? null,
      rejectedAt: b.rejectedAt ?? null,
      cancelledAt: b.cancelledAt ?? null,
    },
    events: Array.isArray(b.events) ? b.events.map(serializeEvent) : undefined,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
  if (audience === "admin" && b.patient) {
    const p = plain(b.patient);
    out.patient = { id: str(p.id), name: p.name, email: p.email ?? null, phone: p.phone ?? null };
  }
  return out;
}

module.exports = {
  typeLabel,
  equipmentList,
  serializeDriver,
  serializeAmbulance,
  serializeProvider,
  serializeBooking,
  providerSummary,
};
