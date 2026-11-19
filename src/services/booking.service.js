/**
 * Booking business logic (docs/booking-payments, docs/consultation-queue).
 * Issues a TOKEN in the day's session, confirms an offline "pay at clinic"
 * booking immediately, exposes the patient's and the doctor's views, and the
 * doctor's mark-paid / complete actions.
 *
 * Race safety is still the DB's job — the guarantee just moved. The generated
 * `active_lock_key` is UNIQUE over (session_id, queue_number) while a booking is
 * live, so two patients holding the same TOKEN is impossible. Above it,
 * `allocateToken` takes a row lock on the session, which is what also makes the
 * optional capacity check safe.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  Booking,
  ConsultationSession,
  Payment,
  DoctorProfile,
  Clinic,
  User,
  PatientProfile,
  Specialization,
  Allergy,
  Condition,
  PatientCurrentMedication,
  UploadedRecord,
  ClinicProfile,
} = require("../models");
const ApiError = require("../utils/ApiError");
const followUpService = require("./followUp.service");
const env = require("../config/env");
const {
  ERROR_CODES,
  BOOKING_MODES,
  BOOKING_STATUS,
  PAYMENT_STATUS,
  SESSION_STATUS,
  QUEUE_STATE,
  LIVE_QUEUE_STATUSES,
  OFFLINE_PAYMENT_METHOD,
  BOOKING_PAYMENT_VIEW_ATTRS,
  NOTIFICATION_TYPES,
} = require("../config/constants");
const paymentQrService = require("./paymentQr.service");
const patientService = require("./patient.service");
const doctorService = require("./doctor.service");
const availabilityService = require("./availability.service");
const sessionService = require("./session.service");
const paymentService = require("./payment.service");
const referralService = require("./referral.service");
const acquisitionService = require("./acquisition.service");
const appointmentNotifications = require("./appointmentNotification.service");

// ── Includes (eager-load; never a query in a loop) ───────────────────────────
const patientView = [
  {
    model: DoctorProfile,
    as: "doctor",
    attributes: ["userId", "onlineFee"],
    include: [
      { model: User, as: "user", attributes: ["name", "profilePhotoUrl"] },
      { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name", "slug"] },
    ],
  },
  { model: Clinic, as: "clinic", attributes: ["id", "name", "addressLine", "city"] },
  { model: Payment, as: "payment", attributes: [...BOOKING_PAYMENT_VIEW_ATTRS] },
  // Who booked it, when it wasn't the patient. LEFT JOIN — NULL on every direct
  // patient→doctor booking, which must keep listing exactly as before.
  {
    model: User,
    as: "bookedBy",
    attributes: ["id", "name", "role"],
    include: [{ model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] }],
  },
];

const doctorListView = [
  // `profilePhotoUrl` is the roster row's avatar — the doctor recognises a
  // returning patient by face faster than by name. The profile join carries the
  // age/address the roster prints under the name (docs/follow-up-status).
  {
    model: User,
    as: "patient",
    attributes: ["id", "name", "phone", "profilePhotoUrl"],
    include: [
      {
        model: PatientProfile,
        as: "patientProfile",
        attributes: ["dateOfBirth", "gender", "addressLine", "city", "state"],
      },
    ],
  },
  // `city` is what the board's Location column reads under the clinic name —
  // a doctor practising at two clinics of the same name needs the city to tell
  // them apart.
  { model: Clinic, as: "clinic", attributes: ["id", "name", "city"] },
  { model: Payment, as: "payment", attributes: [...BOOKING_PAYMENT_VIEW_ATTRS] },
  // Who booked it, when it wasn't the patient. LEFT JOIN — NULL on every direct
  // patient→doctor booking, which must keep listing exactly as before.
  {
    model: User,
    as: "bookedBy",
    attributes: ["id", "name", "role"],
    include: [{ model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] }],
  },
];

/**
 * Newest day first, and within a day in TOKEN order — which is also service
 * order. Sorting by start time stopped meaning anything the moment everyone in
 * a session shared one.
 */
const orderNewestFirst = [
  ["slotDate", "DESC"],
  ["queueNumber", "ASC"],
  ["slotStartTime", "DESC"],
];

/** "YYYY-MM-DD" from a Date (Joi coerces `date` to a UTC-midnight Date). */
const toDateStr = (date) => new Date(date).toISOString().slice(0, 10);

/** DB TIME ("HH:mm:ss") → "HH:mm". */
const hhmmOf = (t) => (t == null ? null : String(t).slice(0, 5));

/**
 * Resolve the authoritative fee + booking_type from the doctor/clinic — NEVER
 * the client. Video uses the doctor's online_fee; clinic uses that clinic's
 * offline_fee. Also returns the availability-vocabulary mode for slot checks.
 */
async function resolveFeeAndMode({ doctorId, mode, clinicId }) {
  if (mode === BOOKING_MODES.VIDEO) {
    const profile = await DoctorProfile.findOne({
      where: { userId: doctorId, ...doctorService.publicListingWhere },
      attributes: ["userId", "onlineFee"],
    });
    if (!profile) throw ApiError.notFound("Doctor not found");
    if (profile.onlineFee == null) {
      throw new ApiError(422, "This doctor doesn't offer video consults", {
        code: ERROR_CODES.SLOT_UNAVAILABLE,
      });
    }
    return { fee: Number(profile.onlineFee), bookingType: "online", resolvedClinicId: null, availMode: "online" };
  }
  const clinic = await Clinic.findOne({
    where: { id: clinicId, doctorId, isActive: true },
    attributes: ["id", "offlineFee"],
  });
  if (!clinic) throw ApiError.notFound("Clinic not found");
  return { fee: Number(clinic.offlineFee), bookingType: "offline", resolvedClinicId: clinic.id, availMode: "clinic" };
}

/**
 * Take the next token in a session, inside the caller's transaction.
 *
 * THE piece that has to be right. It locks the session row, so concurrent
 * bookings for the same day are serialised on one row for well under a
 * millisecond — and different sessions never touch each other at all.
 *
 * Holding that lock is also what makes the capacity check safe. A check-then-
 * insert on an unlocked row is precisely the race the old slot code avoided by
 * never performing one; here the lock closes the window instead, and the UNIQUE
 * key on (session_id, queue_number) is still the backstop underneath.
 *
 * `nextToken` only ever increases: a cancelled #4 does not free the number,
 * because a token a patient has been told is theirs must never be reissued. The
 * QUEUE shrinks instead — position is counted at read time, not stored.
 */
async function allocateToken(session, tx, { patientId = null } = {}) {
  const locked = await ConsultationSession.findByPk(session.id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!locked) {
    throw new ApiError(404, "Session not found", { code: ERROR_CODES.SESSION_NOT_FOUND });
  }
  if ([SESSION_STATUS.COMPLETED, SESSION_STATUS.CANCELLED].includes(locked.status)) {
    throw new ApiError(409, "The doctor has closed that day", { code: ERROR_CODES.SESSION_CLOSED });
  }
  // Duplicate guard for NEW bookings: checked under the session row lock, so two
  // near-simultaneous submits (a double tap, a retried request, a clinic and
  // the patient booking at once) cannot both get a token. Reschedules don't
  // pass a patientId and are unaffected.
  if (patientId != null) {
    const existing = await Booking.findOne({
      where: { sessionId: locked.id, patientId, status: { [Op.in]: LIVE_QUEUE_STATUSES } },
      attributes: ["id"],
      transaction: tx,
    });
    if (existing) {
      throw new ApiError(409, "You already have an appointment with this doctor on that day", {
        code: ERROR_CODES.DUPLICATE_BOOKING,
        details: { bookingId: String(existing.id) },
      });
    }
  }
  if (locked.maxBookings != null) {
    const live = await Booking.count({
      where: { sessionId: locked.id, status: { [Op.in]: LIVE_QUEUE_STATUSES } },
      transaction: tx,
    });
    if (live >= locked.maxBookings) {
      throw new ApiError(409, "That day is fully booked", { code: ERROR_CODES.SESSION_FULL });
    }
  }
  const queueNumber = locked.nextToken;
  await locked.increment("nextToken", { by: 1, transaction: tx });
  return queueNumber;
}

/** The queue columns every new booking carries. */
const queueFields = (session, queueNumber) => ({
  sessionId: session.id,
  queueNumber,
  queueState: QUEUE_STATE.WAITING,
});

/**
 * Create a booking. Gated on a complete patient profile. Recomputes the fee,
 * resolves the day's session and takes the next token, then inserts. Offline
 * ("pay at clinic") confirms immediately; online holds the token until paid.
 */
async function create(
  patientId,
  { doctorId, mode, clinicId, date, paymentMode, referralId, offlineMethod = OFFLINE_PAYMENT_METHOD.CASH, acquisition },
  { bookedByUserId = null } = {}
) {
  await patientService.assertProfileComplete(patientId);

  const { fee, bookingType, resolvedClinicId } = await resolveFeeAndMode({ doctorId, mode, clinicId });
  // Paying the doctor's OWN UPI QR (migration 044) is an offline payment the
  // doctor confirms; the validator already limits it to paymentMode 'offline'.
  const viaUpiQr = paymentMode === "offline" && offlineMethod === OFFLINE_PAYMENT_METHOD.UPI_QR;
  // Video must be paid online (PRD §4.6) — or to the doctor's UPI QR, where the
  // money goes straight to the doctor. Cash can't be handed over a video call,
  // so video + cash is still forced online. Clinic honours the patient's choice.
  const finalPaymentMode = mode === BOOKING_MODES.VIDEO && !viaUpiQr ? "online" : paymentMode;
  if (viaUpiQr) {
    await paymentQrService.requireConfigured(doctorId, "This doctor doesn't accept UPI QR payments right now");
  }

  const dateStr = toDateStr(date);
  /**
   * The day's session, materialised on first use. `resolveWindows` inside it
   * still enforces every gate the slot path enforced — publicly listed, not a
   * blocked date, the clinic is the doctor's — so nothing about who may book
   * what has changed.
   */
  const session = await sessionService.resolveSession({
    doctorId,
    clinicId: resolvedClinicId,
    dateStr,
  });
  if (!session) {
    throw new ApiError(422, "The doctor isn't consulting that day", {
      code: ERROR_CODES.SLOT_UNAVAILABLE,
    });
  }
  // A day whose window has already closed cannot take another token. This is
  // where the slot path checked "that time has already passed".
  if (new Date(`${dateStr}T${hhmmOf(session.endTime)}:00`) <= new Date()) {
    throw new ApiError(422, "That session has already finished", {
      code: ERROR_CODES.SESSION_CLOSED,
    });
  }
  await availabilityService.expireStaleHolds(session.id);

  const slot = {
    dateStr,
    startTime: hhmmOf(session.startTime),
    endTime: hhmmOf(session.endTime),
  };

  // "How did you hear about Dr. X?" (migration 056) — optional, written in the
  // same transaction as the booking. A clinic booking on the patient's behalf
  // is stamped captured_via "clinic"; otherwise the app says web / mobile.
  const recordAcquisition = (b, answer, tx) =>
    acquisitionService.recordForBooking(b, answer, {
      capturedBy: bookedByUserId ?? patientId,
      capturedVia: bookedByUserId ? "clinic" : answer?.capturedVia || "web",
      transaction: tx,
    });

  const bookingFields = {
    patientId,
    doctorId,
    clinicId: resolvedClinicId,
    bookingType,
    // NULL for the direct patient→doctor flow (every booking before the clinic
    // portal existed, and every one a patient still makes themselves). A clinic
    // booking on a patient's behalf stamps its own users.id here, which is what
    // renders "booked by X Clinic" for the doctor and "via X Clinic" for the
    // patient. Nothing else in this function branches on it.
    bookedByUserId,
    slotDate: dateStr,
    slotStartTime: slot.startTime,
    slotEndTime: slot.endTime,
    amount: fee,
  };

  try {
    if (finalPaymentMode === "online") {
      // ── DEV TESTING BYPASS (never in production, never with real keys) ──────
      // When Razorpay isn't configured, there's no gateway to take the payment —
      // which blocks video consults (they're online-only). In development only,
      // confirm the booking immediately with a settled online payment so the flow
      // is testable end to end. In production, or the moment real Razorpay keys
      // are present, this is skipped and the real Checkout flow (below) runs.
      if (env.NODE_ENV !== "production" && !paymentService.isEnabled()) {
        const booking = await sequelize.transaction(async (tx) => {
          const queueNumber = await allocateToken(session, tx, { patientId });
          const b = await Booking.create(
            { ...bookingFields, ...queueFields(session, queueNumber), status: BOOKING_STATUS.CONFIRMED, paymentMode: "online" },
            { transaction: tx }
          );
          const payment = await Payment.create(
            { bookingId: b.id, amount: fee, mode: "online", status: PAYMENT_STATUS.SUCCESS, paidAt: new Date() },
            { transaction: tx }
          );
          paymentService.applySplit(payment);
          await payment.save({ transaction: tx });
          if (referralId) await referralService.linkBooking(b, referralId, tx);
          await recordAcquisition(b, acquisition, tx);
          return b;
        });
        // Provision the video room + meetLink, exactly like the real confirm path.
        await paymentService.provisionVideoConsult(booking);
        await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.APPOINTMENT_BOOKED, booking.id);
        return { booking: await getForPatient(patientId, booking.id), razorpayOrder: null };
      }

      // Online: hold the token (pending_payment), then create the Razorpay order.
      // The insert commits before the external call so we never hold a DB tx
      // open across the network; an abandoned hold is swept after BOOKING_HOLD_MINUTES.
      // When it fulfils a referral, the hold + link are one atomic unit.
      const booking = await sequelize.transaction(async (tx) => {
        const queueNumber = await allocateToken(session, tx, { patientId });
        const b = await Booking.create(
          { ...bookingFields, ...queueFields(session, queueNumber), status: BOOKING_STATUS.PENDING, paymentMode: "online" },
          { transaction: tx }
        );
        if (referralId) await referralService.linkBooking(b, referralId, tx);
        await recordAcquisition(b, acquisition, tx);
        return b;
      });

      let order;
      try {
        order = await paymentService.createOrder(booking);
      } catch (err) {
        // The gateway rejected the order — free the just-held token immediately,
        // and release the referral it fulfilled so the patient can retry.
        booking.status = BOOKING_STATUS.CANCELLED;
        booking.cancelledReason = "order_failed";
        await booking.save();
        if (referralId) await referralService.revertLink(booking);
        throw err;
      }

      await Payment.create({
        bookingId: booking.id,
        amount: fee,
        mode: "online",
        status: PAYMENT_STATUS.INITIATED,
        razorpayOrderId: order.id,
      });
      return { booking: await getForPatient(patientId, booking.id), razorpayOrder: order };
    }

    // Offline: the token is issued + confirmed immediately; payment is collected
    // at the clinic — in cash, or to the doctor's own UPI QR. Either way it sits
    // at `pending_at_clinic` until the DOCTOR confirms receipt (mark-paid); the
    // platform never marks it paid itself. Booking + payment written atomically.
    const booking = await sequelize.transaction(async (tx) => {
      const queueNumber = await allocateToken(session, tx, { patientId });
      const b = await Booking.create(
        { ...bookingFields, ...queueFields(session, queueNumber), status: BOOKING_STATUS.CONFIRMED, paymentMode: "offline" },
        { transaction: tx }
      );
      await Payment.create(
        {
          bookingId: b.id,
          amount: fee,
          mode: "offline",
          offlineMethod: viaUpiQr ? OFFLINE_PAYMENT_METHOD.UPI_QR : OFFLINE_PAYMENT_METHOD.CASH,
          status: PAYMENT_STATUS.PENDING_AT_CLINIC,
        },
        { transaction: tx }
      );
      // A referred appointment is an ordinary booking that carries a referralId —
      // link it to the referral + inherit its journey, atomically with the insert.
      if (referralId) await referralService.linkBooking(b, referralId, tx);
      await recordAcquisition(b, acquisition, tx);
      return b;
    });
    // A video consult paid by UPI QR is confirmed now, so it gets its room +
    // meetLink now — exactly like the online confirm path.
    if (mode === BOOKING_MODES.VIDEO) await paymentService.provisionVideoConsult(booking);
    await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.APPOINTMENT_BOOKED, booking.id);
    return { booking: await getForPatient(patientId, booking.id), razorpayOrder: null };
  } catch (err) {
    // The token key rejected it. Unreachable in practice — the row lock in
    // allocateToken serialises allocation — but it is the backstop that makes
    // "no two patients hold the same token" the DATABASE's guarantee rather
    // than this function's.
    if (err.name === "SequelizeUniqueConstraintError") {
      throw ApiError.conflict("Please try booking again", { code: ERROR_CODES.SLOT_TAKEN });
    }
    throw err;
  }
}

/**
 * Every appointment THIS clinic booked for THIS patient.
 *
 * Scoped to `bookedByUserId` on purpose: a clinic sees the appointments it
 * arranged, not the patient's whole calendar. Appointments the patient booked
 * directly with a doctor stay private to them, exactly as before the clinic
 * portal existed.
 */
function listForClinicPatient(clinicUserId, patientId) {
  return Booking.findAll({
    where: { patientId, bookedByUserId: clinicUserId },
    include: patientView,
    order: orderNewestFirst,
  });
}

/**
 * Verify a Razorpay Checkout signature → confirm the booking (delegates to
 * payment.service), then return the fully-included booking for serialization.
 */
async function verifyPayment(patientId, bookingId, body) {
  await paymentService.verify(patientId, bookingId, body);
  return getForPatient(patientId, bookingId);
}

// ── Patient reads ────────────────────────────────────────────────────────────
function listForPatient(patientId, { status } = {}) {
  const where = { patientId };
  if (status) where.status = status;
  return Booking.findAll({ where, include: patientView, order: orderNewestFirst });
}

async function getForPatient(patientId, id) {
  const booking = await Booking.findOne({ where: { id, patientId }, include: patientView });
  if (!booking) throw ApiError.notFound("Booking not found");
  return booking;
}

// ── Patient: pay the doctor's own UPI QR (migration 044) ─────────────────────
/**
 * The patient's OWN booking whose payment is offline + UPI QR (404 for anyone
 * else's booking — never a 403 that confirms it exists).
 */
async function loadUpiQrBooking(patientId, id) {
  const booking = await Booking.findOne({
    where: { id, patientId },
    include: [
      { model: Payment, as: "payment" },
      {
        model: DoctorProfile,
        as: "doctor",
        attributes: ["userId"],
        include: [{ model: User, as: "user", attributes: ["name"] }],
      },
    ],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  const { payment } = booking;
  if (!payment || payment.mode !== "offline" || payment.offlineMethod !== OFFLINE_PAYMENT_METHOD.UPI_QR) {
    throw ApiError.conflict("This booking isn't paid by UPI QR", { code: ERROR_CODES.PAYMENT_QR_UNAVAILABLE });
  }
  return booking;
}

/** What the patient pays, to whom, with which reference — fed to serializeQrPaymentRequest. */
async function qrPaymentRequest(booking) {
  const qr = await paymentQrService.requireConfigured(
    booking.doctorId,
    "The doctor has removed their UPI QR — please pay at the clinic instead"
  );
  const { payment } = booking;
  return {
    qr,
    fallbackName: booking.doctor?.user?.name ?? null,
    amount: payment.amount,
    reference: `IHS-BK-${booking.id}`,
    paymentStatus: payment.status,
    offlineMethod: payment.offlineMethod,
    reportedAt: payment.payerReportedAt,
    payerReference: payment.payerReference,
  };
}

/**
 * GET /doctors/:id/payment-options (public) — which payment choices the
 * booking screen may offer for this doctor. Says only WHETHER a UPI QR exists;
 * the QR itself is shown to a patient for their own booking, never here.
 */
async function paymentOptionsForDoctor(doctorId) {
  const id = Number(doctorId);
  if (!Number.isSafeInteger(id) || id <= 0) throw ApiError.notFound("Doctor not found");
  const profile = await DoctorProfile.findOne({
    where: { userId: id, ...doctorService.publicListingWhere },
    attributes: ["userId"],
  });
  if (!profile) throw ApiError.notFound("Doctor not found");
  const gateway = paymentService.isEnabled();
  return {
    cashAtClinic: true,
    upiQr: Boolean(await paymentQrService.findConfigured(id)),
    onlineGateway: gateway,
    // The dev bypass in create(): no Razorpay keys outside production confirms
    // an online booking at once, with no money involved.
    testModeAutoConfirm: env.NODE_ENV !== "production" && !gateway,
  };
}

/** GET /patient/bookings/:id/payment-qr — the doctor's QR + amount + reference. */
async function getPaymentQrForPatient(patientId, id) {
  return qrPaymentRequest(await loadUpiQrBooking(patientId, id));
}

/**
 * POST /patient/bookings/:id/payment-report — "I have paid".
 *
 * Records what the patient SAYS (the UPI reference, and when) for the doctor
 * to check in their UPI app. It deliberately changes NEITHER the payment nor
 * the booking status: only the doctor's mark-paid settles it. Re-reporting is
 * allowed while the payment is still pending; a new reference overwrites the
 * old one.
 */
async function reportPaymentForPatient(patientId, id, { reference } = {}) {
  const booking = await loadUpiQrBooking(patientId, id);
  const { payment } = booking;
  if (booking.status === BOOKING_STATUS.CANCELLED || payment.status !== PAYMENT_STATUS.PENDING_AT_CLINIC) {
    throw ApiError.conflict("This booking isn't awaiting a payment", { code: ERROR_CODES.PAYMENT_NOT_PENDING });
  }
  const request = await qrPaymentRequest(booking);
  if (reference) payment.payerReference = reference;
  payment.payerReportedAt = new Date();
  await payment.save({ fields: ["payerReference", "payerReportedAt"] });
  await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.PAYMENT_REPORTED, booking.id);
  return { ...request, reportedAt: payment.payerReportedAt, payerReference: payment.payerReference };
}

// ── Doctor reads ─────────────────────────────────────────────────────────────
/**
 * The doctor's appointment list, each row carrying THAT CONSULTATION'S
 * follow-up (docs/follow-up-status).
 *
 * Fetched in ONE query for the whole page and stitched in memory rather than
 * joined per row. Attached as a non-persisted field the serializer reads.
 */
async function listForDoctor(doctorId, { status, date, clinicId } = {}) {
  const where = { doctorId };
  if (status) where.status = status;
  if (date) where.slotDate = date;
  if (clinicId) where.clinicId = clinicId;

  const bookings = await Booking.findAll({ where, include: doctorListView, order: orderNewestFirst });
  const ids = bookings.map((b) => b.id);
  // Two page-wide lookups, not two per row: the follow-up tag each consult
  // carries, and every referral that points at or out of it.
  const [byBooking, referralsByBooking] = await Promise.all([
    followUpService.mapForBookings(doctorId, ids),
    referralService.mapForBookings(ids),
  ]);
  for (const b of bookings) {
    b.setDataValue("followUp", byBooking.get(String(b.id)) ?? null);
    b.setDataValue("referrals", referralsByBooking.get(String(b.id)) ?? null);
  }
  return bookings;
}

/**
 * A doctor's booking + the patient snapshot. The snapshot (the data the patient
 * saved) is only exposed for confirmed/completed bookings — a doctor can't read
 * patient data off an unpaid pending hold.
 */
async function getForDoctorWithPatientSnapshot(doctorId, id) {
  const booking = await Booking.findOne({
    where: { id, doctorId },
    include: [
      {
        model: User,
        as: "patient",
        include: [
          {
            model: PatientProfile,
            as: "patientProfile",
            include: [
              { model: Allergy, as: "allergies", through: { attributes: ["severity"] } },
              { model: Condition, as: "conditions", through: { attributes: ["diagnosedYear"] } },
              { model: PatientCurrentMedication, as: "medications" },
            ],
          },
          // Identity documents never reach a doctor. required:false keeps the
          // LEFT JOIN — a patient with no documents must still load.
          { model: UploadedRecord, as: "uploadedRecords", where: { fileType: { [Op.ne]: "identity" } }, required: false },
        ],
      },
      { model: Clinic, as: "clinic", attributes: ["id", "name", "addressLine", "city"] },
      { model: Payment, as: "payment", attributes: [...BOOKING_PAYMENT_VIEW_ATTRS] },
    ],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  const showSnapshot = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED].includes(booking.status);
  if (showSnapshot && booking.patient) {
    // Uploaded documents follow clinical-history consent (migration 057):
    // ones this doctor added, plus prescriptions with `medications` and
    // reports / scans with `investigations`. Dropped before serialization.
    const access = require("./clinicalAccess.service");
    const scope = await access.scopeFor(doctorId, booking.patientId);
    const allowed = (booking.patient.uploadedRecords || []).filter((r) => access.recordAllowed(scope, r));
    // An include lives on the instance AND in dataValues — replace both.
    booking.patient.uploadedRecords = allowed;
    booking.patient.setDataValue("uploadedRecords", allowed);
  }
  return { booking, showSnapshot };
}

// ── Doctor actions ───────────────────────────────────────────────────────────
/** Record an at-clinic cash payment: pending_at_clinic → success. */
async function markPaid(doctorId, id) {
  const booking = await Booking.findOne({
    where: { id, doctorId },
    include: [{ model: Payment, as: "payment" }, ...doctorListView.filter((i) => i.as !== "payment")],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  const payment = booking.payment;
  if (!payment || payment.mode !== "offline" || payment.status !== PAYMENT_STATUS.PENDING_AT_CLINIC) {
    throw ApiError.conflict("This booking isn't awaiting an at-clinic payment", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }
  payment.status = PAYMENT_STATUS.SUCCESS;
  payment.paidAt = new Date();
  // Stamp the same commission split the online path stamps. Without this the
  // row lands at success with commission/payout at their 0.00 column defaults,
  // and the consult is worth ₹0 to both the doctor and the platform forever.
  paymentService.applySplit(payment);
  await payment.save();
  await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.PAYMENT_CONFIRMED, booking.id);
  return booking;
}

/**
 * Mark a confirmed booking completed (or no-show).
 *
 * Completing an ATTENDED at-clinic consult also collects the cash: a still
 * `pending_at_clinic` offline payment is settled in the SAME action, so the
 * doctor marks the appointment done in ONE click instead of "mark paid" then
 * "mark complete". A no-show collected nothing, so its payment is left untouched
 * (and the earnings split is never stamped for it). Online payments (already
 * `success`) are unaffected.
 */
async function complete(doctorId, id, { noShow = false } = {}) {
  const booking = await Booking.findOne({
    where: { id, doctorId },
    include: [{ model: Payment, as: "payment" }, ...doctorListView.filter((i) => i.as !== "payment")],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    throw ApiError.conflict("Only a confirmed booking can be completed", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }

  const payment = booking.payment;
  // Only CASH is settled by completing: the doctor took it in hand. A UPI QR
  // payment stays pending until the doctor has checked their UPI app and used
  // mark-paid — completing a consult is not proof the transfer arrived.
  const settlePendingCash =
    !noShow &&
    payment &&
    payment.mode === "offline" &&
    payment.offlineMethod !== OFFLINE_PAYMENT_METHOD.UPI_QR &&
    payment.status === PAYMENT_STATUS.PENDING_AT_CLINIC;

  await sequelize.transaction(async (tx) => {
    if (settlePendingCash) {
      payment.status = PAYMENT_STATUS.SUCCESS;
      payment.paidAt = new Date();
      // Same commission split the online/mark-paid paths stamp — otherwise the
      // consult is worth ₹0 to both the doctor and the platform forever.
      paymentService.applySplit(payment);
      await payment.save({ transaction: tx });
    }
    booking.status = noShow ? BOOKING_STATUS.NO_SHOW : BOOKING_STATUS.COMPLETED;

    /*
     * Closing the token is part of the SAME action, not a second one.
     *
     * A no-show is `skipped`, not `done`: nothing was consulted, so it must not
     * enter the session's measured average and tell everyone still waiting that
     * consults take four minutes.
     */
    if (booking.sessionId) {
      booking.queueState = noShow ? QUEUE_STATE.SKIPPED : QUEUE_STATE.DONE;
      if (!noShow) booking.consultEndedAt = booking.consultEndedAt ?? new Date();
    }
    await booking.save({ transaction: tx });

    if (booking.sessionId) {
      // The doctor is free again — which is what every waiting patient's
      // "doctor is with another patient" reads off.
      await ConsultationSession.update(
        { currentBookingId: null },
        { where: { id: booking.sessionId, currentBookingId: booking.id }, transaction: tx }
      );
      if (!noShow) await sessionService.refreshAverage(booking.sessionId, tx);
    }

    // If this consult fulfilled a referral, an attended completion closes it out.
    if (!noShow) await referralService.completeForBooking(booking, tx);
  });

  if (!noShow) {
    await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.CONSULTATION_COMPLETED, booking.id);
  }
  return booking;
}

/**
 * Move a CONFIRMED booking to another time, keeping everything else
 * (patient, mode, clinic, fee, payment) exactly as it was.
 *
 * The doctor is the one who can't make the original day, so only the doctor
 * initiates this — but the target is resolved through the SAME
 * `session.service.resolveSession` a patient booking goes through, so a
 * reschedule can't land somewhere a patient could never have booked: it must be
 * a day the doctor publishes for this mode, and not a blocked date.
 *
 * `requireListed: false` because the doctor already owns this booking — the
 * public-listing gate is about patient discovery, not appointment management.
 *
 * The patient takes a FRESH token at the tail of the target day. Carrying the
 * old number across would collide with whoever already holds it there, and
 * would also claim a place in a queue the patient never joined.
 */
async function reschedule(doctorId, id, { date, reason = null }) {
  const booking = await Booking.findOne({ where: { id, doctorId } });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    throw ApiError.conflict("Only a confirmed appointment can be rescheduled", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }

  const dateStr = toDateStr(date);
  const from = { date: booking.slotDate, startTime: hhmmOf(booking.slotStartTime) };
  if (from.date === dateStr) {
    throw new ApiError(422, "That is the appointment's current day", {
      code: ERROR_CODES.SLOT_UNAVAILABLE,
    });
  }

  const session = await sessionService.resolveSession({
    doctorId,
    clinicId: booking.clinicId,
    dateStr,
    requireListed: false,
  });
  if (!session) {
    throw new ApiError(422, "You aren't consulting that day", { code: ERROR_CODES.SLOT_UNAVAILABLE });
  }

  const previousSessionId = booking.sessionId;
  try {
    await sequelize.transaction(async (tx) => {
      const queueNumber = await allocateToken(session, tx);
      booking.sessionId = session.id;
      booking.queueNumber = queueNumber;
      booking.queueState = QUEUE_STATE.WAITING;
      booking.calledAt = null;
      booking.consultStartedAt = null;
      booking.slotDate = dateStr;
      booking.slotStartTime = hhmmOf(session.startTime);
      booking.slotEndTime = hhmmOf(session.endTime);
      booking.rescheduledReason = reason;
      booking.rescheduledAt = new Date();
      await booking.save({ transaction: tx });

      // If the doctor was mid-consult with this patient when they moved them,
      // the old day is no longer serving anybody.
      if (previousSessionId) {
        await ConsultationSession.update(
          { currentBookingId: null },
          { where: { id: previousSessionId, currentBookingId: booking.id }, transaction: tx }
        );
      }
    });
  } catch (err) {
    // The token key rejected it. `UniqueConstraintError` used to be referenced
    // here without ever being imported, so a genuine collision threw a
    // ReferenceError and 500'd instead of returning 409.
    if (err.name === "SequelizeUniqueConstraintError") {
      throw new ApiError(409, "Please try again", { code: ERROR_CODES.SLOT_TAKEN });
    }
    throw err;
  }

  await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.APPOINTMENT_RESCHEDULED, booking.id, {
    fromDate: from.date,
  });
  return { booking, from };
}

// ── Patient action ───────────────────────────────────────────────────────────
/**
 * Cancel a booking → the token is released (the generated lock key nulls) and
 * the patient leaves the queue, so everyone behind them moves up one on their
 * next poll. The NUMBER is not reissued — `next_token` only goes up.
 */
async function cancel(patientId, id, reason) {
  const booking = await Booking.findOne({ where: { id, patientId } });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (![BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED].includes(booking.status)) {
    throw ApiError.conflict("This booking can no longer be cancelled", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }
  // The doctor was only ever told about a CONFIRMED booking (a pending online
  // hold never notified them), so only that one needs a cancellation notice.
  const wasConfirmed = booking.status === BOOKING_STATUS.CONFIRMED;
  booking.status = BOOKING_STATUS.CANCELLED;
  booking.cancelledReason = reason ?? null;
  booking.queueState = null;
  await booking.save();
  if (wasConfirmed) {
    await appointmentNotifications.notifyBookingEvent(NOTIFICATION_TYPES.APPOINTMENT_CANCELLED, booking.id);
  }
  // Cancel any pending follow-up reminder for this booking.
  const followUpReminderService = require("./followUpReminder.service");
  await followUpReminderService.cancelForBooking(booking.id);
  return booking;
}

module.exports = {
  create,
  // Exported for the concurrency test in docs/consultation-queue/integration-plan.md
  // §5. Not part of the service's API — nothing else may allocate a token
  // outside a create/reschedule transaction.
  __allocateTokenForTest: allocateToken,
  listForClinicPatient,
  reschedule,
  verifyPayment,
  listForPatient,
  getForPatient,
  getPaymentQrForPatient,
  reportPaymentForPatient,
  paymentOptionsForDoctor,
  listForDoctor,
  getForDoctorWithPatientSnapshot,
  markPaid,
  complete,
  cancel,
};
