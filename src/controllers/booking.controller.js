/**
 * Patient booking controllers — deliberately THIN. Read validated input +
 * `req.user.id`, call one booking.service function, serialize. No business rules.
 */
const bookingService = require("../services/booking.service");
const clinicalNoteService = require("../services/clinicalNote.service");
const videoSessionService = require("../services/videoSession.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { ROLES } = require("../config/constants");
const {
  serializeBookingForPatient,
  serializeRazorpayOrder,
  serializeClinicalNote,
  serializeVideoToken,
  serializeQrPaymentRequest,
} = require("../utils/serializers");

exports.create = asyncHandler(async (req, res) => {
  const { booking, razorpayOrder } = await bookingService.create(req.user.id, req.body);
  const data = serializeBookingForPatient(booking);
  // Online: wrap the booking with its Razorpay order so the client can open
  // Checkout. Offline: return the confirmed booking flat (already paid-at-clinic).
  if (razorpayOrder) {
    return created(
      res,
      { booking: data, payment: data.payment, razorpayOrder: serializeRazorpayOrder(razorpayOrder) },
      "Booking created"
    );
  }
  return created(res, data, "Booking confirmed");
});

exports.verify = asyncHandler(async (req, res) => {
  const booking = await bookingService.verifyPayment(req.user.id, req.params.id, req.body);
  const data = serializeBookingForPatient(booking);
  return ok(res, { booking: data, payment: data.payment }, "Payment verified");
});

exports.list = asyncHandler(async (req, res) => {
  const rows = await bookingService.listForPatient(req.user.id, { status: req.query.status });
  return ok(res, rows.map(serializeBookingForPatient), "Your bookings");
});

exports.getOne = asyncHandler(async (req, res) => {
  const booking = await bookingService.getForPatient(req.user.id, req.params.id);
  return ok(res, serializeBookingForPatient(booking), "Booking");
});

exports.cancel = asyncHandler(async (req, res) => {
  await bookingService.cancel(req.user.id, req.params.id, req.body.reason);
  return ok(res, null, "Booking cancelled");
});

// Pay the doctor's own UPI QR (migration 044): what to pay, and "I have paid".
exports.paymentQr = asyncHandler(async (req, res) => {
  const request = await bookingService.getPaymentQrForPatient(req.user.id, req.params.id);
  return ok(res, serializeQrPaymentRequest(request), "Payment details");
});

exports.reportPayment = asyncHandler(async (req, res) => {
  const request = await bookingService.reportPaymentForPatient(req.user.id, req.params.id, req.body);
  return ok(res, serializeQrPaymentRequest(request), "Payment reported — the doctor will confirm once received");
});

// The doctor's clinical notes from this consultation (read-only for the patient).
exports.clinicalNotes = asyncHandler(async (req, res) => {
  const rows = await clinicalNoteService.listForPatientBooking(req.user.id, req.params.id);
  return ok(res, rows.map(serializeClinicalNote), "Consultation notes");
});

// A LiveKit join token for the patient's own confirmed video consult, in-window.
exports.videoToken = asyncHandler(async (req, res) => {
  const result = await videoSessionService.mintToken({
    bookingId: req.params.id,
    actorId: req.user.id,
    role: ROLES.PATIENT,
  });
  return ok(res, serializeVideoToken(result), "Video token");
});
