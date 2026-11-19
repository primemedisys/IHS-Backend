/**
 * Multi-doctor referral business logic (docs/multi-doctor-referrals).
 *
 * A referral is a directed edge inside a care journey: Dr A ──(reason)──▶ Dr B.
 * The doctor creates one from a consultation they own; the patient acts on it by
 * booking the target, which links the new booking back to the edge (linkBooking).
 *
 * The create gate is IDENTICAL to clinicalNote.assertBookingUnlocked — a referral
 * is made "in the same breath" as the reports + Rx, so it unlocks under exactly
 * the same rule (own, confirmed/completed booking). Ownership is always a WHERE.
 */
const { Op, QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  Booking,
  Payment,
  CareJourney,
  Referral,
  DoctorProfile,
  User,
  Specialization,
  ClinicalNote,
  Clinic,
  Prescription,
  PrescriptionItem,
} = require("../models");
const ApiError = require("../utils/ApiError");
const {
  BOOKING_STATUS,
  PAYMENT_STATUS,
  REFERRAL_STATUS,
  JOURNEY_STATUS,
  REFERRAL_TARGET_LIMIT,
  PRESCRIPTION_STATUS,
  ERROR_CODES,
} = require("../config/constants");

const UNLOCKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];
/** A withdrawn or declined referral no longer hands its case to the target doctor. */
const CLOSED_REFERRAL = [REFERRAL_STATUS.CANCELLED, REFERRAL_STATUS.DECLINED];

/** The mini doctor projection every referral serialization needs (from + to). */
const doctorMini = (as) => ({
  model: DoctorProfile,
  as,
  attributes: ["userId"],
  include: [
    { model: User, as: "user", attributes: ["id", "name", "profilePhotoUrl"] },
    {
      model: Specialization,
      as: "specializations",
      through: { attributes: [] },
      attributes: ["name", "slug"],
    },
  ],
});
const referralInclude = [doctorMini("fromDoctor"), doctorMini("toDoctor")];

/** Load a referral fully hydrated for the serializer (from/to doctor + specs). */
const loadReferral = (id, tx) =>
  Referral.findByPk(id, { include: referralInclude, transaction: tx });

/**
 * Resolve one of the doctor's OWN bookings, enforcing the same unlock rule as the
 * clinical-notes / patient-snapshot gate. Returns the owned booking row.
 */
async function assertOwnedUnlocked(doctorId, bookingId) {
  const booking = await Booking.findOne({
    where: { id: bookingId, doctorId },
    attributes: ["id", "patientId", "clinicId", "status", "journeyId"],
  });
  if (!booking) throw ApiError.notFound("Booking not found"); // not owned / unknown
  if (!UNLOCKED.includes(booking.status)) {
    throw ApiError.forbidden("Refer once the booking is confirmed");
  }
  return booking;
}

/** Assert the target is a real, referable doctor (approved, active, not self). */
async function assertReferableTarget(fromDoctorId, toDoctorId) {
  if (String(toDoctorId) === String(fromDoctorId)) {
    throw new ApiError(422, "You can't refer a patient to yourself", {
      code: ERROR_CODES.REFERRAL_TARGET_INVALID,
    });
  }
  const target = await DoctorProfile.findOne({
    where: { userId: toDoctorId, verificationStatus: "approved" },
    attributes: ["userId"],
    include: [{ model: User, as: "user", attributes: ["id"], where: { isActive: true }, required: true }],
  });
  if (!target) {
    throw new ApiError(422, "This doctor can't receive referrals", {
      code: ERROR_CODES.REFERRAL_TARGET_INVALID,
    });
  }
  return target;
}

/** The most recent diagnosis written on the source booking, for the journey title. */
async function diagnosisForBooking(bookingId) {
  const note = await ClinicalNote.findOne({
    where: { bookingId, diagnosis: { [Op.ne]: null } },
    attributes: ["diagnosis"],
    order: [["createdAt", "DESC"]],
  });
  return note?.diagnosis?.trim() || null;
}

/**
 * Create a referral from the doctor's booking. Lazily opens the care journey (if
 * the source booking has none) and stamps it onto that booking — all in one
 * transaction so a journey is never orphaned.
 */
async function createFromBooking(fromDoctorId, bookingId, { toDoctorId, reason, note }) {
  const booking = await assertOwnedUnlocked(fromDoctorId, bookingId);
  await assertReferableTarget(fromDoctorId, toDoctorId);

  const referralId = await sequelize.transaction(async (tx) => {
    let journeyId = booking.journeyId;
    if (!journeyId) {
      const title = (await diagnosisForBooking(booking.id)) || reason;
      const journey = await CareJourney.create(
        {
          patientId: booking.patientId,
          originDoctorId: fromDoctorId,
          originClinicId: booking.clinicId,
          title: title ? title.slice(0, 200) : null,
          status: JOURNEY_STATUS.OPEN,
        },
        { transaction: tx }
      );
      journeyId = journey.id;
      booking.journeyId = journeyId;
      await booking.save({ transaction: tx });
    }

    const referral = await Referral.create(
      {
        journeyId,
        patientId: booking.patientId,
        fromDoctorId,
        toDoctorId,
        sourceBookingId: booking.id,
        reason,
        note: note || null,
        status: REFERRAL_STATUS.PENDING,
      },
      { transaction: tx }
    );
    return referral.id;
  });

  return loadReferral(referralId);
}

// ── Target-doctor side: "who referred a patient TO me" ───────────────────────
/** The patient a referral concerns, for the target doctor's inbox. */
const patientMini = { model: User, as: "patient", attributes: ["id", "name"] };

/** The referring doctor's Rx (finalized) as read by the referral target. */
const prescriptionCaseInclude = [
  { model: PrescriptionItem, as: "items" },
  {
    model: DoctorProfile,
    as: "doctor",
    attributes: ["userId", "qualification"],
    include: [{ model: User, as: "user", attributes: ["name"] }],
  },
  { model: Clinic, as: "clinic", attributes: ["id", "name", "addressLine"] },
];

/**
 * Referrals sent TO this doctor (the inbox), newest first — "Dr. A referred
 * <patient> to you". Optionally filtered by status. Ownership is the WHERE
 * (`to_doctor_id = doctorId`).
 */
async function listIncoming(doctorId, { status } = {}) {
  const where = { toDoctorId: doctorId };
  if (status) where.status = status;
  return Referral.findAll({
    where,
    include: [doctorMini("fromDoctor"), patientMini],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
}

/**
 * The shared case behind an incoming referral: the referring doctor's clinical
 * notes AND their finalized prescription from the source consultation. The
 * referral is an explicit clinical hand-off, so its target doctor is authorized
 * to read the source consult's reports + Rx (gate: `to_doctor_id = doctorId`).
 */
async function getIncomingCase(doctorId, referralId) {
  const referral = await Referral.findOne({
    where: { id: referralId, toDoctorId: doctorId, status: { [Op.notIn]: CLOSED_REFERRAL } },
    include: [doctorMini("fromDoctor"), patientMini],
  });
  if (!referral) {
    throw new ApiError(404, "Referral not found", { code: ERROR_CODES.REFERRAL_NOT_FOUND });
  }
  const [reports, prescription] = await Promise.all([
    ClinicalNote.findAll({
      where: { bookingId: referral.sourceBookingId },
      include: [{ model: User, as: "author", attributes: ["id", "name"] }],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    }),
    Prescription.findOne({
      where: {
        bookingId: referral.sourceBookingId,
        supersededById: null,
        status: PRESCRIPTION_STATUS.FINALIZED,
      },
      include: prescriptionCaseInclude,
      order: [["finalizedAt", "DESC"]],
    }),
  ]);
  return { referral, reports, prescription };
}

/** The source booking id for a referral targeting this doctor (for the Rx PDF). */
async function sourceBookingForIncoming(doctorId, referralId) {
  const referral = await Referral.findOne({
    where: { id: referralId, toDoctorId: doctorId, status: { [Op.notIn]: CLOSED_REFERRAL } },
    attributes: ["id", "sourceBookingId"],
  });
  if (!referral) {
    throw new ApiError(404, "Referral not found", { code: ERROR_CODES.REFERRAL_NOT_FOUND });
  }
  return String(referral.sourceBookingId);
}

/**
 * Begin the target doctor's consultation for a referral — the "walk-in" flow.
 *
 * The patient is already at the clinic (they walked over from the referring
 * doctor), so there is NO separate patient booking: this creates the target
 * doctor's own appointment on the spot so they can record their notes, write a
 * prescription, complete it, and refer onward — exactly like any appointment.
 *
 * ONE booking, ONE fee: the visit was already paid on the referring appointment,
 * so this consult is ₹0. Its booking exists only to hang B's notes + Rx on and to
 * link into the same care journey. Idempotent: if the referral already has a
 * target booking (patient booked online, or a second click), that one is returned.
 */
async function startConsultation(doctorId, referralId) {
  const referral = await Referral.findOne({ where: { id: referralId, toDoctorId: doctorId } });
  if (!referral) {
    throw new ApiError(404, "Referral not found", { code: ERROR_CODES.REFERRAL_NOT_FOUND });
  }
  // Already consulting — return the existing appointment (idempotent).
  if (referral.targetBookingId) return { bookingId: String(referral.targetBookingId) };
  if (![REFERRAL_STATUS.PENDING, REFERRAL_STATUS.BOOKED].includes(referral.status)) {
    throw new ApiError(409, "This referral is no longer active", {
      code: ERROR_CODES.REFERRAL_NOT_CANCELLABLE,
    });
  }

  // The consult happens at the target doctor's own clinic (clinics are
  // doctor-owned; in the "one clinic, many doctors" case its name+city match the
  // referrer's). Fall back to the source booking's clinic if the target has none.
  const ownClinic = await Clinic.findOne({
    where: { doctorId, isActive: true },
    order: [["id", "ASC"]],
    attributes: ["id"],
  });
  let clinicId = ownClinic ? ownClinic.id : null;
  if (!clinicId) {
    const source = await Booking.findByPk(referral.sourceBookingId, { attributes: ["clinicId"] });
    clinicId = source ? source.clinicId : null;
  }

  // A walk-in has no scheduled slot — stamp "now" to the second so the booking's
  // generated active_lock_key (doctor+date+start) can't collide in practice.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const slotDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hhmmss = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const slotStartTime = hhmmss(now);
  const slotEndTime = hhmmss(new Date(now.getTime() + 15 * 60 * 1000));

  try {
    const bookingId = await sequelize.transaction(async (tx) => {
      const booking = await Booking.create(
        {
          patientId: referral.patientId,
          doctorId,
          clinicId,
          bookingType: "offline",
          slotDate,
          slotStartTime,
          slotEndTime,
          status: BOOKING_STATUS.CONFIRMED, // unlocks the patient snapshot + notes + Rx
          paymentMode: "offline",
          amount: 0,
          journeyId: referral.journeyId,
          referralId: referral.id,
        },
        { transaction: tx }
      );
      // A settled ₹0 payment keeps the 1:1 booking↔payment invariant the rest of
      // the app assumes; commission/payout default to 0.00 (== applySplit of ₹0).
      await Payment.create(
        {
          bookingId: booking.id,
          amount: 0,
          mode: "offline",
          status: PAYMENT_STATUS.SUCCESS,
          paidAt: now,
        },
        { transaction: tx }
      );
      referral.targetBookingId = booking.id;
      referral.status = REFERRAL_STATUS.BOOKED;
      await referral.save({ transaction: tx });
      return booking.id;
    });
    return { bookingId: String(bookingId) };
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      throw ApiError.conflict("Please start the consultation again", { code: ERROR_CODES.SLOT_TAKEN });
    }
    throw err;
  }
}

/** Referrals THIS doctor made from THIS consult, newest first (with the target). */
async function listForBookingPatient(doctorId, bookingId) {
  await assertOwnedUnlocked(doctorId, bookingId);
  return Referral.findAll({
    where: { sourceBookingId: bookingId },
    include: referralInclude,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
}

/**
 * Every referral touching a page of the doctor's bookings, keyed by booking id
 * — the appointment board's Referral column.
 *
 * TWO directions, one query, no query in a loop (README §6):
 *  - `targetBookingId IN ids` → somebody referred this patient TO this doctor,
 *    and this booking is the consult that fulfils it. "Referred by Dr A."
 *  - `sourceBookingId IN ids` → this doctor referred the patient onward FROM
 *    this consult. "Referred to Dr B." A consult can produce several.
 *
 * Returns `Map<bookingId, { incoming, outgoing[] }>`. A booking can appear in
 * both — a patient referred in, examined, then referred on again is the normal
 * shape of a multi-doctor case, not an edge case.
 *
 * Not scoped by doctorId on purpose: the ids are already the caller's own
 * bookings (listForDoctor selected them by `doctorId`), and an incoming
 * referral's `fromDoctorId` is by definition somebody else.
 */
async function mapForBookings(bookingIds) {
  const ids = [...new Set(bookingIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const rows = await Referral.findAll({
    where: {
      [Op.or]: [{ targetBookingId: { [Op.in]: ids } }, { sourceBookingId: { [Op.in]: ids } }],
    },
    include: referralInclude,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });

  const byBooking = new Map();
  const bucket = (id) => {
    const key = String(id);
    let b = byBooking.get(key);
    if (!b) {
      b = { incoming: null, outgoing: [] };
      byBooking.set(key, b);
    }
    return b;
  };
  for (const r of rows) {
    // Newest first, so the first incoming referral seen is the current one.
    if (r.targetBookingId && ids.includes(String(r.targetBookingId))) {
      const b = bucket(r.targetBookingId);
      if (!b.incoming) b.incoming = r;
    }
    if (r.sourceBookingId && ids.includes(String(r.sourceBookingId))) {
      bucket(r.sourceBookingId).outgoing.push(r);
    }
  }
  return byBooking;
}

/**
 * The referral-target autocomplete (Decision §9.2 a+b). One parameterized SQL
 * over doctor_profiles JOIN users, self-excluded, approved + active, name LIKE q,
 * floating "same clinic" matches (name+city of the source clinic) to the top.
 */
async function listTargets(fromDoctorId, { q, clinicId }) {
  let sourceClinic = null;
  if (clinicId) {
    sourceClinic = await Clinic.findByPk(clinicId, { attributes: ["name", "city"] });
  }
  const hasSource = Boolean(sourceClinic);

  // "same clinic" = the target has an active clinic with the same name + city as
  // the source booking's clinic (Decision §9.2b). 0 when no source clinic given.
  const sameClinicExpr = hasSource
    ? `EXISTS (
         SELECT 1 FROM clinics c
          WHERE c.doctor_id = p.user_id AND c.is_active = 1
            AND LOWER(c.name) = LOWER(:clinicName)
            AND LOWER(COALESCE(c.city, '')) = LOWER(:clinicCity)
       )`
    : "0";

  const replacements = {
    self: fromDoctorId,
    q: `%${q}%`,
    limit: REFERRAL_TARGET_LIMIT,
  };
  if (hasSource) {
    replacements.clinicName = sourceClinic.name;
    replacements.clinicCity = sourceClinic.city || "";
  }

  return sequelize.query(
    `SELECT p.user_id AS id,
            u.name AS name,
            u.profile_photo_url AS photo,
            (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '||')
               FROM doctor_specializations ds
               JOIN specializations s ON s.id = ds.specialization_id
              WHERE ds.doctor_id = p.user_id) AS specs,
            (SELECT c.name FROM clinics c
              WHERE c.doctor_id = p.user_id AND c.is_active = 1
              ORDER BY c.id ASC LIMIT 1) AS clinicName,
            ${sameClinicExpr} AS sameClinic
       FROM doctor_profiles p
       JOIN users u ON u.id = p.user_id
      WHERE p.verification_status = 'approved'
        AND u.is_active = 1
        AND p.user_id <> :self
        AND u.name LIKE :q
      ORDER BY sameClinic DESC, u.name ASC, p.user_id ASC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/** Cancel a still-pending referral the caller made. */
async function cancel(fromDoctorId, referralId) {
  const referral = await Referral.findOne({ where: { id: referralId, fromDoctorId } });
  if (!referral) {
    throw new ApiError(404, "Referral not found", { code: ERROR_CODES.REFERRAL_NOT_FOUND });
  }
  if (referral.status !== REFERRAL_STATUS.PENDING) {
    throw new ApiError(409, "This referral can no longer be cancelled", {
      code: ERROR_CODES.REFERRAL_NOT_CANCELLABLE,
    });
  }
  referral.status = REFERRAL_STATUS.CANCELLED;
  await referral.save();
  return loadReferral(referral.id);
}

/**
 * Link a just-created booking to the referral it fulfils — called by
 * booking.service INSIDE the booking-create transaction. Validates the referral
 * is this patient's, targets this doctor, and is still pending; then stamps the
 * booking (journeyId + referralId) and flips the referral to `booked`. Throws to
 * roll the whole booking back on any mismatch (nothing is created half-linked).
 */
async function linkBooking(booking, referralId, tx) {
  const referral = await Referral.findByPk(referralId, { transaction: tx });
  if (!referral) {
    throw new ApiError(404, "Referral not found", { code: ERROR_CODES.REFERRAL_NOT_FOUND });
  }
  const mine = String(referral.patientId) === String(booking.patientId);
  const forThisDoctor = String(referral.toDoctorId) === String(booking.doctorId);
  if (!mine || !forThisDoctor) {
    throw new ApiError(422, "This referral isn't for this appointment", {
      code: ERROR_CODES.REFERRAL_TARGET_INVALID,
    });
  }
  if (referral.status !== REFERRAL_STATUS.PENDING) {
    throw new ApiError(409, "This referral has already been used", {
      code: ERROR_CODES.REFERRAL_ALREADY_LINKED,
    });
  }

  booking.journeyId = referral.journeyId;
  booking.referralId = referral.id;
  await booking.save({ transaction: tx });

  referral.targetBookingId = booking.id;
  referral.status = REFERRAL_STATUS.BOOKED;
  await referral.save({ transaction: tx });
}

/**
 * Called from booking.service.complete (inside its transaction) when a consult is
 * marked complete (never for a no-show). Two effects:
 *
 *  1. This consult's OWN incoming referral flips `booked → completed`.
 *  2. If this is the TERMINAL consult of a care journey — it referred no one
 *     onward still to be seen, and no referral in the journey is still pending —
 *     the whole episode (A→B→C→D) is done. Every consult in the chain is marked
 *     completed, every referral edge is completed, and the journey is closed, so
 *     EVERY doctor in the chain sees "completed" once the last one finishes (the
 *     intermediate doctors in a walk-in never individually mark complete).
 *
 * A no-op for a booking that isn't part of a referral/journey.
 */
async function completeForBooking(booking, tx) {
  // 1) This consult's own incoming referral.
  if (booking.referralId) {
    const incoming = await Referral.findByPk(booking.referralId, { transaction: tx });
    if (incoming && incoming.status === REFERRAL_STATUS.BOOKED) {
      incoming.status = REFERRAL_STATUS.COMPLETED;
      await incoming.save({ transaction: tx });
    }
  }

  // 2) Terminal-consult cascade. Not part of a journey → nothing to close.
  if (!booking.journeyId) return;

  // Onward referrals from THIS consult that still expect a visit (pending) or are
  // mid-consult (booked) → this isn't the end of its branch yet.
  const onwardOpen = await Referral.count({
    where: {
      sourceBookingId: booking.id,
      status: { [Op.in]: [REFERRAL_STATUS.PENDING, REFERRAL_STATUS.BOOKED] },
    },
    transaction: tx,
  });
  if (onwardOpen > 0) return;

  // Anyone in the journey still referred-but-not-yet-seen → don't close early.
  const journeyPending = await Referral.count({
    where: { journeyId: booking.journeyId, status: REFERRAL_STATUS.PENDING },
    transaction: tx,
  });
  if (journeyPending > 0) return;

  // The episode is done — close it out for every doctor in the chain. Bulk status
  // updates only (no payment is touched: each doctor still settles their own
  // at-clinic cash; the referred walk-in consults are ₹0 and already settled).
  await Booking.update(
    { status: BOOKING_STATUS.COMPLETED },
    { where: { journeyId: booking.journeyId, status: BOOKING_STATUS.CONFIRMED }, transaction: tx }
  );
  await Referral.update(
    { status: REFERRAL_STATUS.COMPLETED },
    {
      where: {
        journeyId: booking.journeyId,
        status: { [Op.in]: [REFERRAL_STATUS.PENDING, REFERRAL_STATUS.BOOKED] },
      },
      transaction: tx,
    }
  );
  await CareJourney.update(
    { status: JOURNEY_STATUS.CLOSED },
    { where: { id: booking.journeyId }, transaction: tx }
  );
}

/**
 * Best-effort revert of a link when the booking it fulfilled is abandoned (e.g.
 * an online order failed right after the hold). Never throws — it runs in a catch
 * and must not mask the original error.
 */
async function revertLink(booking) {
  if (!booking.referralId) return;
  try {
    const referral = await Referral.findByPk(booking.referralId);
    if (referral && referral.status === REFERRAL_STATUS.BOOKED) {
      referral.status = REFERRAL_STATUS.PENDING;
      referral.targetBookingId = null;
      await referral.save();
    }
  } catch {
    /* swallow — revert is best-effort */
  }
}

module.exports = {
  createFromBooking,
  listForBookingPatient,
  mapForBookings,
  listIncoming,
  getIncomingCase,
  sourceBookingForIncoming,
  startConsultation,
  listTargets,
  cancel,
  linkBooking,
  revertLink,
  completeForBooking,
  // Shared so careJourney.service embeds the same from/to doctor projection.
  doctorMini,
};
