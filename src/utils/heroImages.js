/**
 * Doctor portfolio hero images (doctor_profiles.hero_image_urls, migration 046)
 * — shared by doctor.service (writes) and the serializers (reads).
 */
const MAX_HERO_IMAGES = 3;

/**
 * The stored hero list, cleaned for use: URL strings only, at most three, in
 * display order. Tolerates NULL and a JSON string (some drivers hand JSON
 * columns back unparsed).
 */
function heroImageList(value) {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((u) => typeof u === "string" && u.trim() !== "").slice(0, MAX_HERO_IMAGES);
}

module.exports = { MAX_HERO_IMAGES, heroImageList };
