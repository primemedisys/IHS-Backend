/**
 * A provider's own UPI QR (migration 044) — shared by the doctor routes
 * (/doctor/payment-qr) and the pharmacy routes (/medicine/pharmacy/payment-qr).
 * Deliberately THIN: the row is ALWAYS the authenticated user's own
 * (req.user.id), never an id from the request.
 */
const paymentQrService = require("../services/paymentQr.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializePaymentQr } = require("../utils/serializers");

exports.get = asyncHandler(async (req, res) =>
  ok(res, serializePaymentQr(await paymentQrService.getOwn(req.user.id)), "Payment QR")
);

exports.update = asyncHandler(async (req, res) =>
  ok(res, serializePaymentQr(await paymentQrService.update(req.user.id, req.body)), "Payment QR saved")
);

exports.uploadImage = asyncHandler(async (req, res) =>
  ok(res, serializePaymentQr(await paymentQrService.uploadImage(req.user.id, req.file)), "Payment QR uploaded")
);

exports.remove = asyncHandler(async (req, res) =>
  ok(res, serializePaymentQr(await paymentQrService.remove(req.user.id)), "Payment QR removed")
);
