/**
 * Case-insensitive identity for the medicine catalogue.
 *
 * Display values keep the user's formatting ("Jerodol-SP"); comparisons go
 * through the normalized form ("JERODOL-SP"): trimmed, inner whitespace
 * collapsed, upper-cased. Shared by the category + medicine-master services
 * and the boot-time backfill so the three can never disagree on "the same".
 */

/** Trim + collapse inner whitespace. Keeps the user's casing (display value). */
function cleanDisplay(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/** Comparison form: cleaned + upper-cased. */
function normalize(value) {
  return cleanDisplay(value).toUpperCase();
}

/**
 * A global medicine is identified by name + strength + form, NOT name alone:
 * "Paracetamol 500mg tablet" and "Paracetamol 650mg tablet" (or a 500mg syrup)
 * are different products. Manufacturer / generic name are descriptive and
 * deliberately excluded — they are optional and often left blank, so keying on
 * them would let the same product be created twice.
 */
function medicineIdentityKey({ medicineName, strength, medicineType }) {
  return [medicineName, strength, medicineType].map(normalize).join("|");
}

module.exports = { cleanDisplay, normalize, medicineIdentityKey };
