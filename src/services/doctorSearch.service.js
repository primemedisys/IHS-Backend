/**
 * Public doctor discovery, executed in the DATABASE.
 *
 * Why this file exists — the previous implementation loaded every approved
 * doctor (plus their clinics, specializations, languages and online schedules),
 * then filtered / sorted / sliced the array in JavaScript. Correct at ten
 * doctors, ruinous at ten thousand, and it silently ignored seven of the
 * filters the frontend sends.
 *
 * Moving it to SQL is not a matter of bolting `limit`/`offset` onto the existing
 * `findAll`, for two reasons:
 *
 *  1. `doctorService.cardInclude` marks `clinics` and `onlineAvailability`
 *     `separate: true` (deliberately — see the comment above `fullInclude`, it
 *     prevents a cartesian blow-up). Rows fetched by a `separate` include run in
 *     their own query and therefore CANNOT appear in the outer `WHERE`.
 *  2. `specializations` / `languages` are `belongsToMany`. JOINing them and then
 *     applying `LIMIT` slices the *joined* row set, not the doctor set, so a
 *     doctor with three specialties eats three slots of the page.
 *
 * So discovery runs in two phases:
 *
 *   Phase 1 (`searchDoctorIds`)  ONE parameterized SQL statement over
 *       `doctor_profiles`, using EXISTS sub-queries for every relation
 *       predicate. Returns just the ordered page of ids + the total count.
 *   Phase 2 (`hydrate`)          Load those ≤ pageSize ids through the existing
 *       `cardInclude` — `separate` is cheap on a tiny id set — and re-apply the
 *       SQL ordering, which `WHERE id IN (...)` does not preserve.
 *
 * The result feeds the untouched `serializePublicDoctor`, so the response shape
 * is byte-for-byte what it was before.
 */
const { Op, QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const { DoctorProfile } = require("../models");
const doctorService = require("./doctor.service");

/**
 * A fee sentinel far above any real consultation fee. `LEAST()` returns NULL if
 * ANY argument is NULL, so each side is COALESCE'd to the sentinel first; if
 * both sides are missing the sentinel survives and `NULLIF` maps it back to 0.
 * That reproduces `serializePublicDoctor`, where a doctor with no fee anywhere
 * gets `consultationFee: 0` (and so passes every `maxFee` filter).
 */
const NO_FEE = 999999999;

/**
 * The listing price, in SQL: the cheapest of {online fee, active clinic fees}.
 * Used by both the `maxFee` filter and the `fee` sort so the number a patient
 * filters on is exactly the number the card renders.
 */
const MIN_FEE_SQL = `
  COALESCE(
    NULLIF(
      LEAST(
        COALESCE(p.online_fee, ${NO_FEE}),
        COALESCE((
          SELECT MIN(c.offline_fee) FROM clinics c
          WHERE c.doctor_id = p.user_id AND c.is_active = 1
        ), ${NO_FEE})
      ),
      ${NO_FEE}
    ),
    0
  )`;

/**
 * The doctor's primary clinic is the first ACTIVE one, matching the serializer's
 * `clinics[0]` (Sequelize returns a `separate` include in primary-key order).
 */
const primaryClinicCol = (col) => `(
  SELECT c.${col} FROM clinics c
  WHERE c.doctor_id = p.user_id AND c.is_active = 1
  ORDER BY c.id ASC LIMIT 1
)`;

/**
 * Great-circle distance in km from (:lat,:lng) to the primary clinic. `LEAST(1.0,
 * ...)` clamps the cosine before ACOS — floating-point drift can push it a hair
 * past 1.0 for a doctor sitting exactly on the search point, which would make
 * ACOS return NULL and silently drop them from the results.
 */
const DISTANCE_SQL = `(
  6371 * ACOS(LEAST(1.0,
    COS(RADIANS(:lat)) * COS(RADIANS(${primaryClinicCol("lat")}))
      * COS(RADIANS(${primaryClinicCol("lng")}) - RADIANS(:lng))
    + SIN(RADIANS(:lat)) * SIN(RADIANS(${primaryClinicCol("lat")}))
  ))
)`;

/**
 * Matches a user-supplied slug against a free-text column: either the raw value
 * ("New Delhi") or its slugified form ("new-delhi"). The frontend's location and
 * symptom pickers speak slugs, while `clinics.city` / `doctor_search_keywords.
 * keyword` store display text.
 */
const slugMatch = (col, param) =>
  `(LOWER(${col}) = LOWER(:${param}) OR LOWER(REPLACE(${col}, ' ', '-')) = LOWER(:${param}))`;

/** An active-clinic EXISTS predicate with an extra condition. */
const activeClinicExists = (cond) => `EXISTS (
  SELECT 1 FROM clinics c
  WHERE c.doctor_id = p.user_id AND c.is_active = 1 AND ${cond}
)`;

/**
 * Translate the validated filter object into a WHERE fragment + replacements.
 * Every value is bound, never interpolated.
 */
function buildWhere(f) {
  // Approved AND not hidden by the admin listing toggle — see
  // doctorService.publicListingSql for why both gates live in one definition.
  const clauses = [doctorService.publicListingSql("p")];
  const replacements = {};

  if (f.search) {
    replacements.q = `%${f.search}%`;
    // The four fields the card surfaces as searchable text.
    clauses.push(`(
      u.name LIKE :q
      OR EXISTS (
        SELECT 1 FROM doctor_specializations ds
        JOIN specializations s ON s.id = ds.specialization_id
        WHERE ds.doctor_id = p.user_id AND s.name LIKE :q
      )
      OR ${activeClinicExists("(c.name LIKE :q OR c.city LIKE :q)")}
    )`);
  }

  if (f.specialtySlug) {
    replacements.specialtySlug = f.specialtySlug;
    // ANY of the doctor's specialties, not just the primary one. The old
    // in-memory filter compared only `specializations[0]`, so a doctor listed as
    // [Orthopedics, Cardiology] was invisible under the Cardiology filter.
    clauses.push(`EXISTS (
      SELECT 1 FROM doctor_specializations ds
      JOIN specializations s ON s.id = ds.specialization_id
      WHERE ds.doctor_id = p.user_id AND s.slug = :specialtySlug
    )`);
  }

  if (Array.isArray(f.includeIds) && f.includeIds.length) {
    replacements.includeIds = f.includeIds;
    clauses.push("p.user_id IN (:includeIds)");
  }

  if (Array.isArray(f.excludeIds) && f.excludeIds.length) {
    replacements.excludeIds = f.excludeIds;
    clauses.push("p.user_id NOT IN (:excludeIds)");
  }

  if (f.subSpecialtySlug) {
    replacements.subSpecialtySlug = f.subSpecialtySlug;
    // Exact catalog slug (from GET /sub-specializations) — never a fuzzy name.
    clauses.push(`EXISTS (
      SELECT 1 FROM doctor_sub_specializations dss
      JOIN sub_specializations ss ON ss.id = dss.sub_specialization_id
      WHERE dss.doctor_id = p.user_id AND ss.slug = :subSpecialtySlug
    )`);
  }

  if (f.language) {
    replacements.language = f.language;
    // Matched by NAME — that is what the serializer puts in `languages[]`.
    clauses.push(`EXISTS (
      SELECT 1 FROM doctor_languages dl
      JOIN languages l ON l.id = dl.language_id
      WHERE dl.doctor_id = p.user_id AND LOWER(l.name) = LOWER(:language)
    )`);
  }

  if (f.symptomSlug) {
    replacements.symptomSlug = f.symptomSlug;
    clauses.push(`EXISTS (
      SELECT 1 FROM doctor_search_keywords k
      WHERE k.doctor_id = p.user_id AND k.is_approved = 1
        AND ${slugMatch("k.keyword", "symptomSlug")}
    )`);
  }

  if (f.city) {
    replacements.city = f.city;
    clauses.push(activeClinicExists(slugMatch("c.city", "city")));
  }

  if (f.stateCode) {
    replacements.stateCode = f.stateCode;
    // `serializePublicDoctor` exposes `clinics.state` AS `stateCode`, so this
    // filters the same column the card displays.
    clauses.push(activeClinicExists(slugMatch("c.state", "stateCode")));
  }

  if (f.hospital) {
    replacements.hospital = `%${f.hospital}%`;
    clauses.push(activeClinicExists("c.name LIKE :hospital"));
  }

  if (f.gender) {
    replacements.gender = f.gender;
    // The serializer defaults a NULL gender to "male"; mirror that here so a
    // doctor who never set the field still matches `gender=male`.
    clauses.push("COALESCE(p.gender, 'male') = :gender");
  }

  if (f.minExperience != null) {
    replacements.minExperience = f.minExperience;
    clauses.push("p.experience_years >= :minExperience");
  }

  if (f.minRating != null) {
    replacements.minRating = f.minRating;
    clauses.push("p.avg_rating >= :minRating");
  }

  if (f.maxFee != null) {
    replacements.maxFee = f.maxFee;
    clauses.push(`${MIN_FEE_SQL} <= :maxFee`);
  }

  if (f.videoConsult) {
    clauses.push(`EXISTS (
      SELECT 1 FROM doctor_online_availability oa
      WHERE oa.doctor_id = p.user_id AND oa.is_active = 1
    )`);
  }

  // Map markers only: drop doctors with no located clinic so no null-island pin
  // is ever rendered (the old code filtered `d.lat && d.lng` after the fact).
  if (f.hasLocation) clauses.push(activeClinicExists("c.lat IS NOT NULL AND c.lng IS NOT NULL"));

  if (f.excludeId != null) {
    replacements.excludeId = f.excludeId;
    clauses.push("p.user_id <> :excludeId");
  }

  // NOTE: `verified` and `available` are intentionally not translated. The list
  // is approved-only (verified is always true) and the serializer hardcodes
  // `available: true`, so both filters are no-ops by construction.

  return { where: clauses.join("\n      AND "), replacements };
}

/**
 * The ORDER BY. Always ends in `p.user_id ASC`: without a unique tiebreak, rows
 * with equal sort keys can be returned in a different order per query, which
 * makes LIMIT/OFFSET drop or duplicate doctors between page 1 and page 2.
 */
function buildOrder(f) {
  switch (f.sort) {
    case "rating":
      return "p.avg_rating DESC, p.user_id ASC";
    case "experience":
      return "p.experience_years DESC, p.user_id ASC";
    case "fee":
      return `${MIN_FEE_SQL} ASC, p.user_id ASC`;
    case "nearest":
      // Validated as lat+lng together, but a doctor with no located clinic still
      // yields NULL — sort those last instead of letting MySQL float them first.
      return f.lat != null && f.lng != null
        ? `${DISTANCE_SQL} IS NULL, ${DISTANCE_SQL} ASC, p.user_id ASC`
        : "p.user_id ASC";
    case "relevance":
    default:
      return "p.user_id ASC";
  }
}

/**
 * Phase 1 — the matching page of doctor ids plus the total match count, in two
 * cheap queries (no relation data loaded).
 */
async function searchDoctorIds(filters = {}) {
  const { where, replacements } = buildWhere(filters);
  const order = buildOrder(filters);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 9;
  const offset = (page - 1) * pageSize;

  const geo = filters.sort === "nearest" ? { lat: filters.lat, lng: filters.lng } : {};
  const bind = { ...replacements, ...geo };

  const [rows, countRows] = await Promise.all([
    sequelize.query(
      `SELECT p.user_id AS id
         FROM doctor_profiles p
         JOIN users u ON u.id = p.user_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...bind, limit: pageSize, offset }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total
         FROM doctor_profiles p
         JOIN users u ON u.id = p.user_id
        WHERE ${where}`,
      { replacements: bind, type: QueryTypes.SELECT }
    ),
  ]);

  return { ids: rows.map((r) => String(r.id)), total: Number(countRows[0].total) };
}

/**
 * Phase 2 — load the card relations for an already-ordered id list and restore
 * that order (`WHERE user_id IN (...)` returns rows in whatever order the engine
 * likes). Returns Sequelize instances, ready for `serializePublicDoctor`.
 */
async function hydrate(ids) {
  if (!ids.length) return [];
  const rows = await DoctorProfile.findAll({
    where: { userId: { [Op.in]: ids } },
    include: doctorService.cardInclude,
  });
  const byId = new Map(rows.map((r) => [String(r.userId), r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Phase 1 + phase 2. The one entry point discovery reads go through. */
async function search(filters = {}) {
  const { ids, total } = await searchDoctorIds(filters);
  return { rows: await hydrate(ids), total };
}

module.exports = { search, searchDoctorIds, hydrate };
