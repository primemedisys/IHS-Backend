/**
 * Razorpay webhook receiver (docs/booking-payments §6.5). Public + unauthenticated
 * — trust comes from the HMAC over the RAW body (captured by app.js's json
 * `verify`). Thin: hand the raw bytes + signature to payment.service and answer
 * 200 on a handled event (so Razorpay stops retrying); a bad signature yields a
 * 400 via the error handler.
 */
const asyncHandler = require("../utils/asyncHandler");
const paymentService = require("../services/payment.service");

exports.handle = asyncHandler(async (req, res) => {
  await paymentService.handleWebhook(req.rawBody, req.headers["x-razorpay-signature"]);
  return res.status(200).json({ received: true });
});
