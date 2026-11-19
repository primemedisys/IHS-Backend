/**
 * Treatment timeline (docs/treatment-timeline) — the patient's whole treatment
 * history as ONE FLAT ROW PER CONSULTATION: date · location · doctor · issue ·
 * prescription.
 *
 * This is a LENS, not a store. Every column already exists on `bookings`,
 * `clinics`, `users`/`doctor_profiles`, `clinical_notes` and `prescriptions`;
 * nothing here writes. Contrast `careJourney.service`, which is the *grouped*
 * lens over the same rows (episodes joined by referral edges). The two share
 * `attachConsultationArtifacts` below so they can never disagree about which
 * note or prescription belongs to a booking.
 *
 * Query budget is FIXED regardless of row count: 1 spine + 1 notes + 1
 * prescriptions + 1 distinct-years (+1 for the doctor gate). No query in a loop.
 */
const { Op, fn, col, literal, where } = require("sequelize");
const {
  Booking,
  DoctorProfile,
  User,
  Specialization,
  Clinic,
  ClinicalNote,
  Prescription,
  ClinicProfile,
  DoctorPatientStatus,
  PatientProfile,
} = require("../models");
const ApiError = require("../utils/ApiError");
const {
  PRESCRIPTION_STATUS,
  TIMELINE_BOOKING_STATUSES,
  TREATED_BOOKING_STATUSES,
  TIMELINE_ROW_CAP,
  TIMELINE_ROSTER_CAP,
  PATIENT_STATUSES,
} = require("../config/constants");
const { gateBookingPatient } = require("./patientVitals.service");
const access = require("./clinicalAccess.service");
const { parseSearch, searchWhere } = require("../utils/patientRegNo");
const { CLINICAL_ACCESS_CATEGORY: CAT } = require("../config/constants");

// ── Shared with careJourney.service ──────────────────────────────────────────
/**
 * Attach each booking's clinical notes and current finalized prescription.
 *
 * ONE query per relation for the WHOLE set (`WHERE booking_id IN (...)`), then
 * grouped in memory — never a query per booking. Extracted from
 * careJourney.service so both lenses resolve "this booking's note / this
 * booking's Rx" identically; if they drifted, a patient comparing the journey
 * view and the timeline would see two different diagnoses for one visit.
 *
 * `supersededById: null` + `status: finalized` means an AMENDED prescription
 * surfaces as the current version only, never both.
 *
 * @param {Array<number|string>} bookingIds
 * @param {{ withAuthor?: object }} [opts] `withAuthor` is the journey's author
 *   include; the timeline doesn't need it and omitting it keeps its query lean.
 * @returns {Promise<{ notesByBooking: Map, rxByBooking: Map }>} keyed by String(bookingId)
 */
async function attachConsultationArtifacts(bookingIds, { withAuthor } = {}) {
  if (!bookingIds.length) return { notesByBooking: new Map(), rxByBooking: new Map() };

  const [notes, prescriptions] = await Promise.all([
    ClinicalNote.findAll({
      where: { bookingId: { [Op.in]: bookingIds } },
      ...(withAuthor ? { include: [withAuthor] } : {}),
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    }),
    Prescription.findAll({
      where: {
        bookingId: { [Op.in]: bookingIds },
        supersededById: null,
        status: PRESCRIPTION_STATUS.FINALIZED,
      },
      // `diagnosis` feeds the timeline's Issue fallback; the journey serializer
      // picks fields explicitly, so carrying it costs that view nothing.
      attributes: ["id", "bookingId", "rxNumber", "pdfUrl", "finalizedAt", "diagnosis"],
      order: [["finalizedAt", "DESC"]],
    }),
  ]);

  const notesByBooking = new Map();
  for (const n of notes) {
    const key = String(n.bookingId);
    if (!notesByBooking.has(key)) notesByBooking.set(key, []);
    notesByBooking.get(key).push(n);
  }

  const rxByBooking = new Map();
  for (const rx of prescriptions) {
    const key = String(rx.bookingId);
    if (!rxByBooking.has(key)) rxByBooking.set(key, rx); // newest finalized wins (DESC)
  }

  return { notesByBooking, rxByBooking };
}

// ── The timeline ─────────────────────────────────────────────────────────────
/** Doctor + clinic ride along the spine; both are belongsTo, so no fan-out. */
const spineInclude = [
  {
    model: DoctorProfile,
    as: "doctor",
    attributes: ["userId"],
    include: [
      { model: User, as: "user", attributes: ["id", "name"] },
      {
        model: Specialization,
        as: "specializations",
        through: { attributes: [] },
        attributes: ["name"],
      },
    ],
  },
  { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
  // Who arranged the consult, for the "via X Clinic" line. LEFT JOIN — NULL on
  // every booking the patient made themselves, which must render exactly as
  // before.
  {
    model: User,
    as: "bookedBy",
    attributes: ["id", "name", "role"],
    include: [{ model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] }],
  },
];

/**
 * Year/month narrowing, in SQL. `month` without `year` is legitimate — "every
 * March, any year" — so it is deliberately not rejected.
 */
function dateFilters({ year, month }) {
  const clauses = [];
  // `sequelize.where(fn(...), value)` BINDS the value. Interpolating it into a
  // literal would put a query-string value straight into SQL.
  if (year) clauses.push(where(fn("YEAR", col("slot_date")), Number(year)));
  if (month) clauses.push(where(fn("MONTH", col("slot_date")), Number(month)));
  return clauses;
}

/**
 * The assembler every path ends in. `patientId` has ALREADY been authorized by
 * the caller — this function does no access checking of its own, which is why
 * it is private to this module.
 */
async function assemble(patientId, filters = {}, scope = null) {
  const dir = filters.sort === "oldest" ? "ASC" : "DESC";
  // A doctor (scope) sees their own consultations, and other doctors' only
  // with the patient's `consultations` grant (migration 057).
  const own = scope ? access.bookingWhere(scope) : {};
  const where = {
    patientId,
    status: { [Op.in]: TIMELINE_BOOKING_STATUSES },
    ...own,
    [Op.and]: dateFilters(filters),
  };

  const [bookings, yearRows] = await Promise.all([
    Booking.findAll({
      where,
      include: spineInclude,
      // The id tiebreak is load-bearing: without it two same-date, same-time
      // bookings come back in engine order and can shuffle between requests.
      order: [
        ["slotDate", dir],
        ["slotStartTime", dir],
        ["id", dir],
      ],
      limit: TIMELINE_ROW_CAP,
    }),
    // Its own query on purpose: deriving the year list from the capped page
    // would hide every year that falls beyond the cap.
    Booking.findAll({
      where: { patientId, status: { [Op.in]: TIMELINE_BOOKING_STATUSES }, ...own },
      attributes: [[fn("DISTINCT", fn("YEAR", col("slot_date"))), "year"]],
      order: [[literal("year"), "DESC"]],
      raw: true,
    }),
  ]);

  const { notesByBooking, rxByBooking } = await attachConsultationArtifacts(
    bookings.map((b) => b.id)
  );

  return {
    rows: bookings.map((booking) =>
      maskRow(
        {
          booking,
          note: (notesByBooking.get(String(booking.id)) || [])[0] || null,
          prescription: rxByBooking.get(String(booking.id)) || null,
        },
        scope
      )
    ),
    years: yearRows.map((r) => Number(r.year)).filter(Boolean),
    total: bookings.length,
    capped: bookings.length >= TIMELINE_ROW_CAP,
  };
}

/**
 * On ANOTHER doctor's row (visible through `consultations`), the note needs
 * `doctor_notes`, the prescription `medications`, and any diagnosis written on
 * either needs `diagnoses`. Hidden parts are dropped here, server-side.
 */
function maskRow(row, scope) {
  if (!scope || scope.isOwn(row.booking.doctorId)) return row;
  let { note, prescription } = row;
  if (note && !scope.has(CAT.DOCTOR_NOTES)) note = null;
  if (prescription && !scope.has(CAT.MEDICATIONS)) prescription = null;
  if (!scope.has(CAT.DIAGNOSES)) {
    if (note) note.setDataValue("diagnosis", null);
    if (prescription) prescription.setDataValue("diagnosis", null);
  }
  return { ...row, note, prescription };
}

/** The patient's own timeline. Ownership IS the WHERE, never a post-filter. */
const listForPatient = (patientId, filters) => assemble(patientId, filters);

/**
 * §5.3 — the in-appointment / in-video-call path. Booking-keyed: the patient is
 * DERIVED from a booking the doctor owns, so the caller never names a patient
 * and cannot pivot from their own appointment to somebody else's. Reuses the
 * same unlock gate as the vitals record table, so the two can't diverge.
 */
async function listByBooking(doctorId, bookingId, filters) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  return assemble(booking.patientId, filters, await access.scopeFor(doctorId, booking.patientId));
}

/**
 * §5.4 — the My Patients path. Here the client DOES name a patient, so assert
 * the treating relationship first. 404 (not 403): a 403 would confirm that the
 * patient exists.
 */
async function listByPatient(doctorId, patientId, filters) {
  const treated = await Booking.findOne({
    where: { doctorId, patientId, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
    attributes: ["id"],
  });
  if (!treated) throw ApiError.notFound("Patient not found");
  return assemble(patientId, filters, await access.scopeFor(doctorId, patientId));
}

/**
 * The My Patients roster — every patient this doctor has consulted, newest
 * contact first. ONE grouped query.
 *
 * Derived from the doctor's OWN bookings and never from a patients table: a
 * doctor must not be able to enumerate people they have not treated.
 *
 * `group` lists both `patientId` and `patient.id` because MySQL 8 runs
 * ONLY_FULL_GROUP_BY by default and rejects a non-aggregated selected column
 * that isn't grouped.
 */
const ROSTER_ORDER = Object.freeze({
  recent: [[literal("lastSeenOn"), "DESC"]],
  oldest: [[literal("lastSeenOn"), "ASC"]],
  name: [[{ model: User, as: "patient" }, "name", "ASC"]],
  visits: [[literal("consultationCount"), "DESC"], [literal("lastSeenOn"), "DESC"]],
});

/**
 * `q` searches name / mobile / registration no. / id (same rules as the
 * workbench). With `page` the roster is paginated server-side (`total` = all
 * matches); without it the legacy call returns everything up to the cap.
 */
async function listDoctorPatients(doctorId, { q, page, limit = 20, sort = "recent", status } = {}) {
  const search = searchWhere(parseSearch(q));
  const rosterWhere = search
    ? { [Op.and]: [{ doctorId, status: { [Op.in]: TREATED_BOOKING_STATUSES } }, search] }
    : { doctorId, status: { [Op.in]: TREATED_BOOKING_STATUSES } };
  const paged = page != null;
  const patientInclude = { model: User, as: "patient", attributes: ["id", "name", "phone", "profilePhotoUrl"], required: true };
  // The category filter runs in SQL so pages stay correct: effective status =
  // the doctor's override, else new (one visit) / OPD follow-up (more). The
  // doctor id is the authenticated id (a number); the status value is bound.
  const effective = literal(
    "COALESCE((SELECT s.status FROM doctor_patient_statuses s " +
      `WHERE s.doctor_id = ${Number(doctorId)} AND s.patient_id = \`Booking\`.\`patient_id\`), ` +
      "CASE WHEN COUNT(`Booking`.`id`) <= 1 THEN 'new_patient' ELSE 'opd_followup' END)"
  );
  const having = status ? where(effective, status) : undefined;
  const grouped = { where: rosterWhere, group: ["Booking.patient_id", "patient.id"], ...(having ? { having } : {}) };
  // Total = matching patients (one grouped id-only query; a doctor's roster is small).
  const totalMatches = paged
    ? (await Booking.findAll({ ...grouped, attributes: ["patientId"], include: [{ ...patientInclude, attributes: ["id"] }], raw: true })).length
    : null;
  const rows = await Booking.findAll({
    ...grouped,
    ...(paged ? { limit, offset: (page - 1) * limit } : { limit: TIMELINE_ROSTER_CAP }),
    attributes: [
      "patientId",
      [fn("COUNT", col("Booking.id")), "consultationCount"],
      [fn("MAX", col("slot_date")), "lastSeenOn"],
      // The anchor for "open this patient's full record": the description page
      // is keyed by booking. MAX(id) approximates the latest visit — exact
      // enough, since that page shows the WHOLE record whatever it is anchored
      // to; the booking only supplies the "this visit" date chip.
      [fn("MAX", col("Booking.id")), "lastBookingId"],
    ],
    include: [patientInclude],
    order: ROSTER_ORDER[sort] ?? ROSTER_ORDER.recent,
  });

  // Overrides + addresses in TWO bounded queries (never one per row). The
  // effective status is override ?? derived: first visit = new patient, any
  // repeat = OPD follow-up. The surgery pair can only come from an override —
  // nothing in booking data can know an operation is planned.
  const ids = rows.map((r) => r.patientId);
  const [overrides, profiles] = ids.length
    ? await Promise.all([
        DoctorPatientStatus.findAll({ where: { doctorId, patientId: { [Op.in]: ids } } }),
        PatientProfile.findAll({
          where: { userId: { [Op.in]: ids } },
          attributes: ["userId", "addressLine", "city", "gender", "dateOfBirth"],
        }),
      ])
    : [[], []];
  const statusById = new Map(overrides.map((o) => [String(o.patientId), o.status]));
  const profileById = new Map(profiles.map((p) => [String(p.userId), p]));

  const patients = rows.map((r) => {
    const derived =
      Number(r.get("consultationCount")) <= 1 ? PATIENT_STATUSES.NEW : PATIENT_STATUSES.OPD_FOLLOWUP;
    return {
      row: r,
      profile: profileById.get(String(r.patientId)) ?? null,
      status: statusById.get(String(r.patientId)) ?? derived,
    };
  });

  if (paged) {
    return {
      patients,
      total: totalMatches,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalMatches / limit)),
      capped: false,
    };
  }
  return {
    patients,
    total: patients.length,
    capped: patients.length >= TIMELINE_ROSTER_CAP,
  };
}

/**
 * The doctor's manual status override. Gated on a real treating relationship —
 * an id with no treated booking 404s, so the endpoint cannot be used to probe
 * which patient ids exist on the platform.
 */
async function setPatientStatus(doctorId, patientId, status) {
  const treated = await Booking.count({
    where: { doctorId, patientId, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
  });
  if (!treated) throw ApiError.notFound("Patient not found");
  await DoctorPatientStatus.upsert({ doctorId, patientId, status });
  return status;
}

/**
 * §5.4 — the CLINIC path. Access is already proven by the route (an approved
 * clinic + `resolveClinicPatient`), so there is no treating relationship to
 * assert here; a thin, deliberately separate export rather than reusing
 * `listByPatient`, which would demand a doctor a clinic doesn't have.
 */
function listForClinicPatient(patientId, filters) {
  return assemble(patientId, filters);
}

/**
 * Which of `patientIds` this doctor TREATS (has a confirmed/completed booking
 * with) — the platform's existing access rule. ONE grouped query.
 * @returns {Promise<Set<string>>}
 */
async function treatedPatientIds(doctorId, patientIds) {
  const ids = [...new Set((patientIds || []).map(String))];
  if (!ids.length) return new Set();
  const rows = await Booking.findAll({
    where: { doctorId, patientId: { [Op.in]: ids }, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
    attributes: ["patientId"],
    group: ["patientId"],
    raw: true,
  });
  return new Set(rows.map((r) => String(r.patientId)));
}

module.exports = {
  treatedPatientIds,
  attachConsultationArtifacts,
  listForPatient,
  listForClinicPatient,
  listByBooking,
  listByPatient,
  listDoctorPatients,
  setPatientStatus,
};
