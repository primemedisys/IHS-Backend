/**
 * Razorpay online-payment logic (docs/booking-payments Phase 3). Wraps the
 * `razorpay` SDK for order creation and owns the two confirm paths — the client
 * `verify` (fast) and the `handleWebhook` (reliable backstop) — which BOTH
 * funnel through `confirmPaid`. `confirmPaid` early-returns when the payment is
 * already `success`, so a payment is confirmed AT MOST ONCE no matter which
 * arrives first or how many times Razorpay retries (PRD §8).
 *
 * The key secret and webhook secret NEVER leave the backend; only the public
 * RAZORPAY_KEY_ID is echoed to the client (in the order response).
 */
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { sequelize, Booking, Payment } = require("../models");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const {
  ERROR_CODES,
  BOOKING_STATUS,
  PAYMENT_STATUS,
  PLATFORM_COMMISSION_PCT,
} = require("../config/constants");
const livekitService = require("./livekit.service");
const videoSessionService = require("./videoSession.service");

/** Round to 2 decimals (money). */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

let client = null;
/**
 * Lazily build the Razorpay client. Throws a clean 503 (not a boot crash) when
 * keys aren't configured yet, so the offline "pay at clinic" flow keeps working
 * and the online path degrades gracefully until test keys are added to `.env`.
 */
function getClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError(503, "Online payment isn't configured yet", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }
  if (!client) {
    client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }
  return client;
}

/** Whether online payments are usable (keys present). */
function isEnabled() {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/**
 * Create a Razorpay order for a held booking. Amount goes to Razorpay in PAISE
 * (`₹ × 100`); the receipt/notes carry the booking id for reconciliation.
 */
async function createOrder(booking) {
  const order = await getClient().orders.create({
    amount: Math.round(Number(booking.amount) * 100),
    currency: "INR",
    receipt: `booking_${booking.id}`,
    notes: { bookingId: String(booking.id) },
  });
  return order;
}

/**
 * Stamp the platform/doctor split onto a payment that is about to become
 * `success`. The ONLY place the commission rate is applied — both the online
 * (`confirmPaid`, here) and offline (`booking.service.markPaid`) confirm paths
 * call it, so they cannot drift again. The offline path used to skip the split
 * entirely, leaving every "pay at clinic" consult worth ₹0 to both the doctor
 * and the platform (docs/dashboards-earnings/README.md §4.1).
 *
 * Mutates in place; the caller saves. The split is STORED, never re-derived at
 * read time: a future change to PLATFORM_COMMISSION_PCT must not retroactively
 * rewrite historical rows.
 */
function applySplit(payment) {
  const commission = round2(Number(payment.amount) * PLATFORM_COMMISSION_PCT);
  payment.commissionAmount = commission;
  payment.doctorPayoutAmount = round2(Number(payment.amount) - commission);
}

/**
 * Provision a confirmed VIDEO consult (docs/video-consultation): stamp the in-app
 * "Join call" deep link onto the booking and create its pending video_sessions
 * row. Idempotent; a no-op for clinic bookings and when LiveKit isn't configured.
 * Best-effort — a provisioning hiccup must never fail the payment path (the token
 * endpoint re-creates the session lazily). Shared by the real confirm path
 * (`confirmPaid`) and the dev auto-confirm path (booking.service).
 */
async function provisionVideoConsult(booking) {
  if (!livekitService.isEnabled() || !videoSessionService.isVideoBooking(booking)) return;
  try {
    // The patient app is the first origin in the comma-separated CLIENT_URL list.
    const patientOrigin = env.CLIENT_URL.split(",")[0].trim();
    booking.meetLink = `${patientOrigin}/dashboard/appointments/${booking.id}/call`;
    await booking.save();
    await videoSessionService.getOrCreateSession(booking);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[video] provisioning failed for booking ${booking.id}:`, err.message);
  }
}

/**
 * The ONE writer that confirms a paid ONLINE booking. Idempotent: a no-op if
 * the payment is already `success`. Records the commission split on success.
 */
async function confirmPaid(booking, payment, { razorpayPaymentId, razorpaySignature } = {}) {
  if (payment.status === PAYMENT_STATUS.SUCCESS) return; // already confirmed — idempotent

  await sequelize.transaction(async (tx) => {
    payment.status = PAYMENT_STATUS.SUCCESS;
    payment.razorpayPaymentId = razorpayPaymentId ?? payment.razorpayPaymentId;
    payment.razorpaySignature = razorpaySignature ?? payment.razorpaySignature;
    payment.paidAt = new Date();
    applySplit(payment);
    await payment.save({ transaction: tx });

    booking.status = BOOKING_STATUS.CONFIRMED;
    await booking.save({ transaction: tx });
  });

  // Provision the video consult (deep link + pending session). Deliberately
  // OUTSIDE the confirm transaction and best-effort (docs/video-consultation).
  await provisionVideoConsult(booking);
  // Lazy require: appointmentNotification → models only, but booking.service
  // requires this file, so keep the load order trivially acyclic.
  await require("./appointmentNotification.service").notifyBookingEvent(
    require("../config/constants").NOTIFICATION_TYPES.APPOINTMENT_BOOKED,
    booking.id
  );
  // Hook: sendBookingConfirmation / payment-receipt email is DEFERRED to Phase 4.
}

/**
 * Client fast-path verify. Confirms the Checkout signature and, on match,
 * confirms the booking. Idempotent: repeat verify on an already-`success`
 * payment returns the confirmed booking, not an error.
 */
async function verify(patientId, bookingId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const booking = await Booking.findOne({
    where: { id: bookingId, patientId },
    include: [{ model: Payment, as: "payment" }],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  const payment = booking.payment;
  if (!payment || payment.mode !== "online") {
    throw ApiError.conflict("This booking isn't an online payment", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }

  if (payment.status === PAYMENT_STATUS.SUCCESS) return booking; // idempotent no-op

  if (booking.status !== BOOKING_STATUS.PENDING) {
    throw ApiError.conflict("This booking can no longer be paid for", {
      code: ERROR_CODES.BOOKING_NOT_PAYABLE,
    });
  }

  // The signature must be for THIS booking's order. Without this check one
  // genuine payment's {order, payment, signature} triple could be replayed to
  // confirm any other pending booking for free.
  if (!payment.razorpayOrderId || razorpayOrderId !== payment.razorpayOrderId) {
    throw new ApiError(400, "Payment could not be verified", {
      code: ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
    });
  }

  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  if (!timingSafeEqualHex(expected, razorpaySignature)) {
    throw new ApiError(400, "Payment could not be verified", {
      code: ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
    });
  }

  await confirmPaid(booking, payment, { razorpayPaymentId, razorpaySignature });
  return booking;
}

/**
 * Webhook backstop (`payment.captured` / `order.paid`). Verifies the HMAC over
 * the RAW body, then confirms idempotently. Returns a boolean "handled" so the
 * controller can always answer 200 on a handled event (Razorpay stops retrying)
 * and 400 only on a bad signature.
 */
async function handleWebhook(rawBody, signatureHeader) {
  if (!rawBody || !rawBody.length) {
    throw new ApiError(400, "Empty webhook body");
  }
  // An empty secret would make the HMAC forgeable (production already requires it).
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw new ApiError(503, "Payment webhooks are not configured");
  }
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  if (!signatureHeader || !timingSafeEqualHex(expected, signatureHeader)) {
    throw new ApiError(400, "Invalid webhook signature");
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  // Only a captured payment / paid order confirms a booking — never e.g.
  // `payment.failed`, which carries the same order_id.
  if (!WEBHOOK_CONFIRM_EVENTS.includes(event?.event)) return;
  const entity =
    event?.payload?.payment?.entity || event?.payload?.order?.entity || {};
  const orderId = entity.order_id || entity.id;
  const razorpayPaymentId = event?.payload?.payment?.entity?.id ?? null;
  if (!orderId) return; // nothing actionable — still a handled event (200)

  const payment = await Payment.findOne({
    where: { razorpayOrderId: orderId },
    include: [{ model: Booking, as: "booking" }],
  });
  if (!payment || !payment.booking) return; // unknown order — acknowledge and move on
  if (payment.status === PAYMENT_STATUS.SUCCESS) return; // already confirmed — idempotent

  await confirmPaid(payment.booking, payment, { razorpayPaymentId });
}

/** Razorpay events that mean "money received" for an order. */
const WEBHOOK_CONFIRM_EVENTS = Object.freeze(["payment.captured", "order.paid"]);

/** Constant-time compare of two hex strings (length-safe). */
function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  isEnabled,
  createOrder,
  verify,
  handleWebhook,
  confirmPaid,
  provisionVideoConsult,
  applySplit,
};
