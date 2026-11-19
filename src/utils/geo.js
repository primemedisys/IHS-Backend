/**
 * Great-circle helpers for location search (ambulance module, migration 040).
 *
 * The SQL expression is the same clamped spherical-law-of-cosines form
 * doctorSearch.service uses for "nearest": LEAST(1.0, …) keeps floating-point
 * drift from pushing the cosine past 1, which would make ACOS return NULL and
 * silently drop a row sitting exactly on the search point.
 */
const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 111.045;

const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km (haversine), unrounded. */
function haversineKm(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * SQL distance (km) from the bound point (:lat, :lng) to a row's coordinate
 * columns. Column names are code constants, never user input.
 */
function distanceSql(latCol, lngCol) {
  return `(${EARTH_RADIUS_KM} * ACOS(LEAST(1.0,
    COS(RADIANS(:lat)) * COS(RADIANS(${latCol})) * COS(RADIANS(${lngCol}) - RADIANS(:lng))
    + SIN(RADIANS(:lat)) * SIN(RADIANS(${latCol}))
  )))`;
}

/**
 * A lat/lng bounding box around a point — a cheap, index-friendly pre-filter
 * applied before the exact distance test.
 */
function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const cos = Math.cos(rad(lat));
  // Near the poles the longitude span explodes; clamp to the whole range.
  const dLng = cos < 0.01 ? 180 : radiusKm / (KM_PER_DEGREE_LAT * cos);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: Math.max(-180, lng - dLng),
    maxLng: Math.min(180, lng + dLng),
  };
}

module.exports = { haversineKm, distanceSql, boundingBox };
