/**
 * Care-journey assembler (docs/multi-doctor-referrals §8). A journey is the
 * ordered set of a patient's consultations joined by referral edges, plus the
 * reports (clinical_notes) and prescription hanging off each. This service is a
 * LINKER and a LENS — it only READS notes/Rx (their own services own writes).
 *
 * Ownership is always a WHERE (`patient_id = req.user.id`); another patient's
 * journey id simply 404s. No N+1: notes + prescriptions are batched with
 * `WHERE booking_id IN (...)` and grouped in memory.
 */
const { Op } = require("sequelize");
const {
  CareJourney,
  Referral,
  Booking,
  DoctorProfile,
  User,
  Specialization,
  Clinic,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { REFERRAL_STATUS, ERROR_CODES } = require("../config/constants");
const { doctorMini } = require("./referral.service");
const { attachConsultationArtifacts } = require("./treatmentTimeline.service");

/** The doctor + clinic each consultation node renders. */
const consultationInclude = [
  {
    model: DoctorProfile,
    as: "doctor",
    attributes: ["userId"],
    include: [
      { model: User, as: "user", attributes: ["id", "name", "profilePhotoUrl"] },
      { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name", "slug"] },
    ],
  },
  { model: Clinic, as: "clinic", attributes: ["id", "name"] },
];

/** The author to show next to each report. */
const withAuthor = { model: User, as: "author", attributes: ["id", "name"] };

/** "YYYY-MM-DD" comparison keeps the latest activity date across a journey's bookings. */
const laterDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * The patient's journeys (newest first) as cheap summaries + their pending
 * referral inbox. One extra batched query loads every journey's bookings so the
 * consultation/doctor counts don't run a query per journey.
 */
async function listForPatient(patientId) {
  const journeys = await CareJourney.findAll({
    where: { patientId },
    order: [["createdAt", "DESC"]],
  });

  const journeyIds = journeys.map((j) => j.id);
  const byJourney = new Map();
  if (journeyIds.length) {
    const bookings = await Booking.findAll({
      where: { journeyId: { [Op.in]: journeyIds } },
      attributes: ["id", "journeyId", "doctorId", "slotDate"],
    });
    for (const b of bookings) {
      const key = String(b.journeyId);
      if (!byJourney.has(key)) byJourney.set(key, []);
      byJourney.get(key).push(b);
    }
  }

  const summaries = journeys.map((j) => {
    const bs = byJourney.get(String(j.id)) || [];
    const doctorCount = new Set(bs.map((b) => String(b.doctorId))).size;
    const lastBookingDate = bs.reduce((acc, b) => laterDate(acc, b.slotDate), null);
    return {
      journey: j,
      consultationCount: bs.length,
      doctorCount,
      lastActivityAt: lastBookingDate || j.updatedAt || j.createdAt,
    };
  });

  const pendingReferrals = await Referral.findAll({
    where: { patientId, status: REFERRAL_STATUS.PENDING },
    include: [doctorMini("fromDoctor"), doctorMini("toDoctor")],
    order: [["createdAt", "DESC"]],
  });

  return { summaries, pendingReferrals };
}

/**
 * The full episode: the journey, its consultations in referral-chain order (each
 * with its reports + prescription), and the referral edges connecting them.
 * Ownership is the WHERE — a journey that isn't the patient's 404s.
 */
async function getForPatient(patientId, journeyId) {
  const journey = await CareJourney.findOne({
    where: { id: journeyId, patientId },
    include: [
      { model: DoctorProfile, as: "originDoctor", attributes: ["userId"], include: [{ model: User, as: "user", attributes: ["name"] }] },
      { model: Clinic, as: "originClinic", attributes: ["id", "name"] },
    ],
  });
  if (!journey) {
    throw new ApiError(404, "Care journey not found", { code: ERROR_CODES.JOURNEY_NOT_FOUND });
  }

  // Ordered by the sequence the consultations JOINED the journey (creation order),
  // NOT slot date: the origin consult is booked first (lowest id/createdAt), and
  // each referred consult is created as the patient is referred onward — so this
  // renders the chain first-doctor → last-doctor (1, 2, 3…) top-to-bottom. Slot
  // date can't be trusted for this: a walk-in referral stamps "now", while the
  // origin booking may sit on a later scheduled date, which would flip the order.
  const consultations = await Booking.findAll({
    where: { journeyId: journey.id },
    include: consultationInclude,
    order: [
      ["createdAt", "ASC"],
      ["id", "ASC"],
    ],
  });
  const bookingIds = consultations.map((b) => b.id);

  // Batch the reports + prescriptions across every consultation (no N+1).
  // `attachConsultationArtifacts` lives in treatmentTimeline.service and is
  // shared with the flat timeline lens, so both views resolve "this booking's
  // note / this booking's Rx" identically and can never show one visit two
  // different ways. `withAuthor` is passed because the journey renders the note
  // author; the timeline omits it.
  const [{ notesByBooking, rxByBooking }, edges] = await Promise.all([
    attachConsultationArtifacts(bookingIds, { withAuthor }),
    Referral.findAll({
      where: { journeyId: journey.id },
      attributes: ["id", "sourceBookingId", "targetBookingId", "reason", "status"],
      order: [["createdAt", "ASC"], ["id", "ASC"]],
    }),
  ]);

  const doctorCount = new Set(consultations.map((b) => String(b.doctorId))).size;
  const lastActivityAt =
    consultations.reduce((acc, b) => laterDate(acc, b.slotDate), null) ||
    journey.updatedAt ||
    journey.createdAt;

  return {
    journey,
    consultations: consultations.map((booking) => ({
      booking,
      reports: notesByBooking.get(String(booking.id)) || [],
      prescription: rxByBooking.get(String(booking.id)) || null,
    })),
    edges,
    doctorCount,
    consultationCount: consultations.length,
    lastActivityAt,
  };
}

module.exports = { listForPatient, getForPatient };
