/**
 * Public-profile slug helpers. `doctor_profiles` has no slug column (README §4.2
 * Q1) — instead we derive a stable, URL-safe slug from the doctor's name + their
 * user id: `dr-<name-kebab>-<id>`. The trailing `-<id>` is the real key (stable
 * across name edits); the name part is cosmetic/SEO. The reverse parse pulls the
 * id back out so the public route is an O(1) primary-key lookup, no new column.
 */

/** Lowercase, strip accents/punctuation, collapse to single hyphens. */
function kebab(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the public slug for a doctor: `dr-asha-rao-12`. */
function doctorSlug(name, userId) {
  const namePart = kebab(name);
  return namePart ? `dr-${namePart}-${userId}` : `dr-${userId}`;
}

/**
 * Pull the numeric user id back out of a slug. Accepts the full `dr-name-12`
 * form as well as a bare numeric id, and returns null if there's no valid
 * trailing id.
 */
function parseDoctorId(slug) {
  const match = String(slug || "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Slug for a sub-specialization row: `{parentSlug}-{name-kebab}`. The parent
 * prefix keeps the globally-unique `sub_specializations.slug` from colliding
 * when two parents share a sub-specialty name (e.g. "Sports Medicine"). The
 * seeder and the doctor "add new" path both build slugs here, so a doctor-added
 * entry and a later seeded one with the same name resolve to the same row.
 */
function subSpecSlug(parentSlug, name) {
  return `${parentSlug}-${kebab(name)}`;
}

module.exports = { kebab, doctorSlug, parseDoctorId, subSpecSlug };
