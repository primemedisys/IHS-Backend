/**
 * Prescription request controller — thin handlers that delegate to the service.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const prescriptionRequestService = require("../services/prescriptionRequest.service");

// ── Patient routes ───────────────────────────────────────────────────────

exports.uploadAndShare = asyncHandler(async (req, res) => {
  const requests = await prescriptionRequestService.uploadAndShare(req.user.id, req.file, req.body);
  return created(res, { requests }, "Prescription shared with providers");
});

exports.getMyRequests = asyncHandler(async (req, res) => {
  const result = await prescriptionRequestService.getMyRequests(req.user.id, req.validatedQuery);
  return ok(res, result);
});

// ── Provider routes ──────────────────────────────────────────────────────

exports.getProviderRequests = asyncHandler(async (req, res) => {
  const result = await prescriptionRequestService.getProviderRequests(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const request = await prescriptionRequestService.updateStatus(
    req.user.id,
    req.params.id,
    req.body.status
  );
  return ok(res, { request });
});

exports.submitAvailability = asyncHandler(async (req, res) => {
  const request = await prescriptionRequestService.submitAvailability(
    req.user.id,
    req.params.id,
    req.body.items
  );
  return ok(res, { request });
});

// ── Patient: order placed off a prescription request ─────────────────────

exports.placeOrderFromPrescription = asyncHandler(async (req, res) => {
  const { items, ...order } = req.body;
  const result = await prescriptionRequestService.placeOrderFromPrescription(
    req.user.id,
    req.params.id,
    items,
    order
  );
  return created(res, result, "Order placed from prescription");
});

exports.addPrescriptionToCart = asyncHandler(async (req, res) => {
  const cart = await prescriptionRequestService.addPrescriptionToCart(
    req.user.id,
    req.params.id,
    req.body.items
  );
  return created(res, { cart }, "Added to cart");
});

// ── Shared (patient or provider) ─────────────────────────────────────────

exports.getRequestById = asyncHandler(async (req, res) => {
  const request = await prescriptionRequestService.getRequestById(req.user.id, req.params.id);
  return ok(res, { request });
});

exports.streamFile = asyncHandler(async (req, res) => {
  const file = await prescriptionRequestService.streamFile(req.user.id, req.params.id);
  res.setHeader("Content-Type", file.contentType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.fileName)}"`
  );
  res.setHeader("Content-Length", file.buffer.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(file.buffer);
});