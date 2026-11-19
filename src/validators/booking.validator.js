/**
 * Joi schemas for the booking endpoints. Shape only — whether the doctor
 * actually consults that day, whether the day is full, and profile completeness
 * are business rules enforced in the service (session.resolveSession /
 * booking.allocateToken / patient.assertProfileComplete).
 *
 * The client speaks `mode: 'video' | 'clinic'` and NEVER sends an amount — the
 * service computes the fee from the doctor/clinic (README §4).
 */
const Joi = require("joi");
const {
  BOOKING_MODES,
  OFFLINE_PAYMENT_METHOD,
  ACQUISITION_SOURCES,
  ACQUISITION_CAPTURED_VIA,
  ACQUISITION_UTM_KEYS,
} = require("../config/constants");

/**
 * "How did you hear about Dr. X?" (migration 056) — optional. Only catalogue
 * values are accepted; free text only where the catalogue offers it.
 */
const acquisition = Joi.object({
  source: Joi.string()
    .valid(...ACQUISITION_SOURCES.map((s) => s.value))
    .required(),
  otherText: Joi.string().trim().max(120).allow("", null),
  referralDetails: Joi.string().trim().max(160).allow("", null),
  capturedVia: Joi.string().valid(...ACQUISITION_CAPTURED_VIA.filter((v) => v !== "clinic")),
  utm: Joi.object(Object.fromEntries(ACQUISITION_UTM_KEYS.map((k) => [k, Joi.string().trim().max(100).allow("")]))),
});

const createBooking = Joi.object({
  doctorId: Joi.number().integer().positive().required(),
  mode: Joi.string()
    .valid(...Object.values(BOOKING_MODES))
    .required(),
  // Required only for an in-clinic visit; forbidden for a video consult.
  clinicId: Joi.number()
    .integer()
    .positive()
    .when("mode", { is: BOOKING_MODES.CLINIC, then: Joi.required(), otherwise: Joi.forbidden() }),
  // The DAY, not a time. Under the consultation queue the patient picks a
  // clinic and a date and receives a token; there is no time to send.
  date: Joi.date().iso().required(),
  // Video is online-only; a clinic visit may pay online or at the clinic. The
  // service still force-normalises video→online, so this is the patient's
  // preference, not the source of truth.
  paymentMode: Joi.string().valid("online", "offline").required(),
  // How an OFFLINE payment is made (migration 044): cash at the clinic, or the
  // doctor's own UPI QR. `upi_qr` needs paymentMode 'offline' (an online
  // payment has no offline method) and is the only offline choice a video
  // consult accepts — the service enforces that, plus "the doctor has a QR".
  offlineMethod: Joi.string()
    .valid(...Object.values(OFFLINE_PAYMENT_METHOD))
    .default(OFFLINE_PAYMENT_METHOD.CASH)
    .when("paymentMode", {
      is: "online",
      then: Joi.valid(Joi.override, OFFLINE_PAYMENT_METHOD.CASH).messages({
        "any.only": "offlineMethod 'upi_qr' requires paymentMode 'offline'",
      }),
    }),
  // Optional: when this booking fulfils a referral, the service links it to the
  // referral + inherits its journey (docs/multi-doctor-referrals). Absent =
  // today's behaviour, unchanged.
  referralId: Joi.number().integer().positive().optional(),
  acquisition: acquisition.optional(),
});

// The three fields Razorpay's Checkout `handler` returns, echoed back to verify.
const verifyPayment = Joi.object({
  razorpayOrderId: Joi.string().trim().required(),
  razorpayPaymentId: Joi.string().trim().required(),
  razorpaySignature: Joi.string().trim().required(),
});

const cancelBooking = Joi.object({
  reason: Joi.string().trim().max(255).allow("", null),
});

const completeBooking = Joi.object({
  noShow: Joi.boolean().default(false),
});

/**
 * A doctor moving one of their own confirmed appointments. Only the TIME
 * changes — mode, clinic, patient and fee are read from the existing booking,
 * never accepted from the client, so a reschedule can't quietly become a
 * different consultation.
 */
/** Moving an appointment moves the DAY; the patient takes a fresh token there. */
const rescheduleBooking = Joi.object({
  date: Joi.date().iso().required(),
  reason: Joi.string().trim().max(255).allow("", null).default(null),
});

module.exports = {
  createBooking,
  verifyPayment,
  cancelBooking,
  completeBooking,
  rescheduleBooking,
};
