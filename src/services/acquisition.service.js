/**
 * Patient acquisition sources (migration 056) — "How did you hear about Dr. X?"
 *
 * Rules:
 *  - The answer is OPTIONAL and only ever what the patient chose. Nothing is
 *    inferred from device / browser / IP; UTM parameters are stored apart and
 *    never replace the answer.
 *  - ORIGINAL discovery source: one row per (patient, doctor), created by the
 *    first booking that carries an answer, never overwritten (UNIQUE key +
 *    ignoreDuplicates).
 *  - BOOKING source: one row per booking, written in the booking's own
 *    transaction, so a failed booking leaves nothing behind.
 */
const { PatientAcquisitionSource, BookingAcquisitionSource } = require("../models");
const {
  ACQUISITION_GROUPS,
  ACQUISITION_SOURCES,
  ACQUISITION_UTM_KEYS,
} = require("../config/constants");

const BY_VALUE = new Map(ACQUISITION_SOURCES.map((s) => [s.value, s]));

/** The catalogue the booking forms render, grouped. */
function catalogue() {
  return {
    groups: ACQUISITION_GROUPS.map((g) => ({
      value: g.value,
      label: g.label,
      sources: ACQUISITION_SOURCES.filter((s) => s.group === g.value).map((s) => ({
        value: s.value,
        label: s.label,
        textField: Boolean(s.textField),
        referral: Boolean(s.referral),
      })),
    })),
  };
}

/** Keep only known UTM keys with short string values; null when nothing is left. */
function cleanUtm(utm) {
  if (!utm || typeof utm !== "object") return null;
  const out = {};
  for (const k of ACQUISITION_UTM_KEYS) {
    if (typeof utm[k] === "string" && utm[k].trim()) out[k] = utm[k].trim().slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Record the answer given on a booking (inside the booking's transaction).
 * No answer → nothing is written (the patient simply wasn't asked or skipped).
 */
async function recordForBooking(booking, acquisition, { capturedBy, capturedVia, transaction }) {
  if (!acquisition?.source) return;
  const def = BY_VALUE.get(acquisition.source);
  if (!def) return; // the validator already restricts values; defensive only
  const fields = {
    patientId: booking.patientId,
    doctorId: booking.doctorId,
    sourceGroup: def.group,
    source: def.value,
    otherText: def.textField ? acquisition.otherText || null : null,
    referralDetails: def.referral ? acquisition.referralDetails || null : null,
    capturedVia,
    utm: cleanUtm(acquisition.utm),
  };
  await BookingAcquisitionSource.create({ bookingId: booking.id, ...fields }, { transaction });
  // First answer wins for the ORIGINAL source; later bookings never overwrite it.
  await PatientAcquisitionSource.bulkCreate(
    [{ ...fields, firstBookingId: booking.id, capturedBy: capturedBy ?? null }],
    { ignoreDuplicates: true, transaction }
  );
}

/** The patient's original discovery answer for one doctor, or null. */
async function originalFor(patientId, doctorId) {
  return PatientAcquisitionSource.findOne({
    where: { patientId, doctorId },
    attributes: ["sourceGroup", "source", "createdAt"],
  });
}

function labelOf(source) {
  return BY_VALUE.get(source)?.label ?? source;
}

module.exports = { catalogue, recordForBooking, originalFor, labelOf, BY_VALUE };
