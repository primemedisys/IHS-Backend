/**
 * The patient's display registration number: "IHS-P-000123". It is the REAL
 * user id in a fixed format — nothing is invented, and it never changes.
 */
const { Op } = require("sequelize");
const { PATIENT_REG_PREFIX } = require("../config/constants");

const regNoOf = (userId) => (userId == null ? null : `${PATIENT_REG_PREFIX}${String(userId).padStart(6, "0")}`);

/** A registration number, a bare patient id or a booking id typed into search. */
function parseSearch(q) {
  const text = String(q || "").trim();
  if (!text) return null;
  const reg = new RegExp(`^${PATIENT_REG_PREFIX}0*(\\d+)$`, "i").exec(text);
  const digits = /^\d+$/.test(text) ? text : null;
  return { text, patientId: reg ? reg[1] : null, digits };
}

/**
 * The patient-side WHERE for a search on a Booking query, applied through the
 * required `patient` include. Name / mobile are LIKE matches (bound, never
 * interpolated); a registration number or bare number also matches the patient
 * id, and a bare number matches the visit (booking) id on booking-level lists.
 * Shared by the workbench roster and My Patients so both search the same way.
 */
function searchWhere(search, { bookingLevel } = {}) {
  if (!search) return null;
  const like = `%${search.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const or = [{ "$patient.name$": { [Op.like]: like } }, { "$patient.phone$": { [Op.like]: like } }];
  if (search.patientId) or.push({ patientId: search.patientId });
  if (search.digits) {
    or.push({ patientId: search.digits });
    if (bookingLevel) or.push({ id: search.digits });
  }
  return { [Op.or]: or };
}

module.exports = { regNoOf, parseSearch, searchWhere };
