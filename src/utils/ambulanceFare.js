/**
 * The ONE ambulance pricing model (migration 040) — deliberately simple:
 *
 *   estimated fare = base fare + (estimated distance × per-km rate)
 *                    [+ emergency surcharge, when the booking is an emergency]
 *   final fare     = base fare + (actual or estimated km × per-km rate)
 *                    + emergency surcharge + (waiting minutes / 60 × waiting charge per hour)
 *
 * Pure functions, no DB: the search, estimate, booking and completion paths
 * all call these, so the number a patient is quoted and the number stored on
 * the booking can never drift apart.
 *
 * Distances are ESTIMATES: great-circle × ROUTE_FACTOR (roads are never
 * straight). ETAs are ESTIMATES from the ambulance's registered base location
 * at AVERAGE_SPEED_KMPH — not a live vehicle position.
 */
const { haversineKm } = require("./geo");
const { AMBULANCE_ESTIMATE } = require("../config/ambulance");

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const km1 = (n) => Math.round(n * 10) / 10;

/** Estimated road distance (km, 0.1 precision) between two points. */
function estimatedRoadKm(aLat, aLng, bLat, bLng) {
  return km1(haversineKm(aLat, aLng, bLat, bLng) * AMBULANCE_ESTIMATE.ROUTE_FACTOR);
}

/** Minutes to cover `km` at the configured average speed (at least 1). */
function etaMinutesFor(km) {
  return Math.max(1, Math.ceil((km / AMBULANCE_ESTIMATE.AVERAGE_SPEED_KMPH) * 60));
}

/**
 * Quote a trip for one ambulance.
 * @param {{baseFare, perKmRate, emergencySurcharge, waitingChargePerHour, baseLat, baseLng}} ambulance
 * @param {{pickupLat, pickupLng, dropLat, dropLng, emergency?: boolean}} trip
 */
function quote(ambulance, { pickupLat, pickupLng, dropLat, dropLng, emergency = false }) {
  const distanceKm = estimatedRoadKm(pickupLat, pickupLng, dropLat, dropLng);
  const baseFare = money(ambulance.baseFare);
  const perKmRate = money(ambulance.perKmRate);
  const emergencySurcharge = emergency ? money(ambulance.emergencySurcharge) : 0;
  const hasBase = ambulance.baseLat != null && ambulance.baseLng != null;
  const toPickupKm = hasBase ? estimatedRoadKm(ambulance.baseLat, ambulance.baseLng, pickupLat, pickupLng) : null;
  return {
    distanceKm,
    baseFare,
    perKmRate,
    emergencySurcharge,
    waitingChargePerHour: ambulance.waitingChargePerHour == null ? null : money(ambulance.waitingChargePerHour),
    estimatedFare: money(baseFare + distanceKm * perKmRate + emergencySurcharge),
    /** From the ambulance's registered base, not a live position. */
    etaMinutes: toPickupKm == null ? null : etaMinutesFor(toPickupKm),
    toPickupKm,
  };
}

/** Final fare from a booking's snapshot + what the provider recorded at completion. */
function finalFare(booking, { actualDistanceKm, waitingMinutes }) {
  const km = actualDistanceKm ?? booking.estimatedDistanceKm;
  const waiting =
    waitingMinutes && booking.waitingChargePerHour ? (waitingMinutes / 60) * booking.waitingChargePerHour : 0;
  return money(booking.baseFare + km * booking.perKmRate + (booking.emergencySurcharge || 0) + waiting);
}

module.exports = { estimatedRoadKm, etaMinutesFor, quote, finalFare, money };
