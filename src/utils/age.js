/**
 * Whole years between a date of birth and today.
 *
 * Extracted from prescription.service once vitals reference ranges needed the
 * same number (docs/vitals-reference-ranges §4 gates its adult bands on age).
 * Two copies would eventually disagree at a birthday boundary, and one of the
 * consumers stamps its answer onto a signed medical document.
 *
 * UTC throughout, deliberately: `date_of_birth` is a DATEONLY, so local-time
 * arithmetic would shift the birthday by a day for anyone west of Greenwich.
 */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

module.exports = { ageFrom };
