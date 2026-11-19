/**
 * Public ambulance discovery (migration 040): reference data, nearby search,
 * one ambulance's public card, and a trip estimate.
 *
 * VISIBILITY — the ONE rule, expressed once for SQL (search) and once for
 * Sequelize (details / booking), both from here:
 *   provider account active AND role ambulance_provider
 *   AND provider profile approved AND active
 *   AND ambulance approved AND active
 *   AND availability available | on_trip   (on_trip is shown but not bookable)
 * A pending / rejected / suspended / deactivated ambulance never appears and
 * its public URL 404s.
 *
 * NEARBY is a true radius search done by the database: a bounding-box
 * pre-filter, then the exact great-circle distance (utils/geo) from the
 * pickup to the ambulance's registered BASE, limited to both the caller's
 * radius and the ambulance's own service radius, ordered available-first then
 * nearest. Distances / ETAs are labelled estimates (no live GPS exists).
 */
const { Op, QueryTypes } = require("sequelize");
const { sequelize, User, Ambulance, AmbulanceProviderProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");
const A = require("../config/ambulance");
const { distanceSql, boundingBox } = require("../utils/geo");
const { quote } = require("../utils/ambulanceFare");
const { serializeAmbulance } = require("../utils/ambulanceSerializers");

const VISIBLE_AVAILABILITY = [A.AMBULANCE_AVAILABILITY.AVAILABLE, A.AMBULANCE_AVAILABILITY.ON_TRIP];

const ESTIMATE_NOTE =
  "Distance, fare and arrival time are estimates from the ambulance's registered base location. " +
  "The provider confirms the booking; the final fare is based on the actual trip.";

/** Sequelize form of the visibility rule (details + booking). */
const publicProviderInclude = {
  model: User,
  as: "provider",
  attributes: ["id", "name", "phone", "city", "state"],
  where: { isActive: true, role: ROLES.AMBULANCE_PROVIDER },
  required: true,
  include: [
    {
      model: AmbulanceProviderProfile,
      as: "ambulanceProviderProfile",
      attributes: ["organizationName", "phone", "emergencyPhone", "is24x7"],
      where: { verificationStatus: A.AMBULANCE_VERIFICATION.APPROVED, isActive: true },
      required: true,
    },
  ],
};
const publicAmbulanceWhere = {
  verificationStatus: A.AMBULANCE_VERIFICATION.APPROVED,
  isActive: true,
  availabilityStatus: { [Op.in]: VISIBLE_AVAILABILITY },
};

/**
 * Load one publicly visible ambulance (or 404). Used by the details page and,
 * inside the booking transaction, by booking creation — so a booking can only
 * ever be made against an ambulance the public search would show.
 */
async function loadVisible(id, { transaction } = {}) {
  const ambulance = await Ambulance.findOne({
    where: { id, ...publicAmbulanceWhere },
    include: [publicProviderInclude],
    transaction,
  });
  if (!ambulance) throw ApiError.notFound("Ambulance not found or not available");
  return ambulance;
}
exports.loadVisible = loadVisible;

/** Static reference data every client renders (types, equipment, statuses, flow). */
exports.reference = () => ({
  types: A.AMBULANCE_TYPE_KEYS.map((key) => ({ key, ...A.AMBULANCE_TYPES[key] })),
  equipment: A.AMBULANCE_EQUIPMENT_KEYS.map((key) => ({ key, label: A.AMBULANCE_EQUIPMENT[key] })),
  availability: Object.values(A.AMBULANCE_AVAILABILITY),
  manualAvailability: A.AMBULANCE_MANUAL_AVAILABILITY,
  verification: Object.values(A.AMBULANCE_VERIFICATION),
  bookingStatuses: Object.values(A.AMBULANCE_BOOKING_STATUS).map((key) => ({ key, label: A.AMBULANCE_STATUS_LABELS[key] })),
  bookingFlow: A.AMBULANCE_BOOKING_FLOW,
  providerTransitions: A.AMBULANCE_PROVIDER_TRANSITIONS,
  patientCancellable: A.AMBULANCE_PATIENT_CANCELLABLE,
  estimate: {
    routeFactor: A.AMBULANCE_ESTIMATE.ROUTE_FACTOR,
    averageSpeedKmph: A.AMBULANCE_ESTIMATE.AVERAGE_SPEED_KMPH,
    defaultRadiusKm: A.AMBULANCE_ESTIMATE.DEFAULT_RADIUS_KM,
    maxRadiusKm: A.AMBULANCE_ESTIMATE.MAX_RADIUS_KM,
  },
  estimateNote: ESTIMATE_NOTE,
});

/** Distance/ETA/fare for one ambulance and one pickup (+ optional drop). */
function computed(ambulance, { lat, lng, dropLat, dropLng, emergency }) {
  const hasDrop = dropLat != null && dropLng != null;
  const q = quote(ambulance, {
    pickupLat: lat,
    pickupLng: lng,
    dropLat: hasDrop ? dropLat : lat,
    dropLng: hasDrop ? dropLng : lng,
    emergency: Boolean(emergency && ambulance.isEmergencyAvailable),
  });
  return {
    /** Estimated road km from the ambulance's base to the pickup. */
    distanceKm: q.toPickupKm,
    etaMinutes: q.etaMinutes,
    estimate: hasDrop
      ? {
          distanceKm: q.distanceKm,
          baseFare: q.baseFare,
          perKmRate: q.perKmRate,
          emergencySurcharge: q.emergencySurcharge,
          estimatedFare: q.estimatedFare,
        }
      : null,
  };
}

/**
 * Nearby, publicly visible ambulances for a pickup point. Two queries total:
 * one SQL page of ids + distances (and its count), one load of those rows.
 */
exports.nearby = async ({ lat, lng, radiusKm, ambulanceType, emergency, dropLat, dropLng, page = 1, limit = 20 }) => {
  const box = boundingBox(lat, lng, radiusKm);
  const dist = distanceSql("a.base_lat", "a.base_lng");
  const clauses = [
    "a.verification_status = :approved",
    "a.is_active = 1",
    "a.availability_status IN (:visible)",
    "a.base_lat IS NOT NULL AND a.base_lng IS NOT NULL",
    "a.base_lat BETWEEN :minLat AND :maxLat",
    "a.base_lng BETWEEN :minLng AND :maxLng",
    `${dist} <= :radius`,
    `${dist} <= COALESCE(a.service_radius_km, :defaultServiceRadius)`,
  ];
  const rep = {
    lat,
    lng,
    radius: radiusKm,
    defaultServiceRadius: A.AMBULANCE_ESTIMATE.DEFAULT_SERVICE_RADIUS_KM,
    approved: A.AMBULANCE_VERIFICATION.APPROVED,
    visible: VISIBLE_AVAILABILITY,
    available: A.AMBULANCE_AVAILABILITY.AVAILABLE,
    role: ROLES.AMBULANCE_PROVIDER,
    ...box,
    limit,
    offset: (page - 1) * limit,
  };
  if (ambulanceType) {
    clauses.push("a.ambulance_type = :type");
    rep.type = ambulanceType;
  }
  if (emergency) clauses.push("a.is_emergency_available = 1");

  const from = `
    FROM ambulances a
    JOIN users u ON u.id = a.provider_id AND u.is_active = 1 AND u.role = :role
    JOIN ambulance_provider_profiles p ON p.user_id = a.provider_id
         AND p.verification_status = :approved AND p.is_active = 1
    WHERE ${clauses.join(" AND ")}`;

  const [page1, [{ total }]] = await Promise.all([
    sequelize.query(
      `SELECT a.id, ${dist} AS distance ${from}
        ORDER BY (a.availability_status = :available) DESC, distance ASC, a.id ASC
        LIMIT :limit OFFSET :offset`,
      { replacements: rep, type: QueryTypes.SELECT }
    ),
    sequelize.query(`SELECT COUNT(*) AS total ${from}`, { replacements: rep, type: QueryTypes.SELECT }),
  ]);

  const ids = page1.map((r) => r.id);
  const rows = ids.length
    ? await Ambulance.findAll({ where: { id: { [Op.in]: ids } }, include: [publicProviderInclude] })
    : [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const ambulances = ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((a) => serializeAmbulance(a, "public", computed(a, { lat, lng, dropLat, dropLng, emergency })));

  return {
    ambulances,
    total: Number(total),
    page,
    limit,
    totalPages: Math.ceil(Number(total) / limit),
    radiusKm,
    estimateNote: ESTIMATE_NOTE,
  };
};

/** One visible ambulance's public card, with distance/fare when a pickup (and drop) is given. */
exports.getPublic = async (id, { lat, lng, dropLat, dropLng, emergency } = {}) => {
  const ambulance = await loadVisible(id);
  const extra = lat != null && lng != null ? computed(ambulance, { lat, lng, dropLat, dropLng, emergency }) : {};
  return { ...serializeAmbulance(ambulance, "public", extra), estimateNote: ESTIMATE_NOTE };
};

/** The fare a booking for this trip would be created with (same function the booking uses). */
exports.estimate = async (id, { pickupLat, pickupLng, dropLat, dropLng, emergency }) => {
  const ambulance = await loadVisible(id);
  const q = quote(ambulance, {
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    emergency: Boolean(emergency && ambulance.isEmergencyAvailable),
  });
  return { ambulanceId: String(ambulance.id), ...q, estimateNote: ESTIMATE_NOTE };
};

exports.ESTIMATE_NOTE = ESTIMATE_NOTE;
