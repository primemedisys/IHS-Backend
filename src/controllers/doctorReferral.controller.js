/**
 * Doctor referral controllers — deliberately THIN. Read `req.doctorId` (set by
 * resolveDoctorId) + validated input, call one referral.service function,
 * serialize. Ownership + the confirmed/completed gate live in the service.
 */
const referralService = require("../services/referral.service");
const prescriptionService = require("../services/prescription.service");
const { streamPdf } = require("./prescription.controller");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeReferral,
  serializeReferralTarget,
  serializeIncomingReferral,
  serializeReferralCase,
} = require("../utils/serializers");

/** POST /doctor/bookings/:id/referrals — refer this consult onward. */
exports.create = asyncHandler(async (req, res) => {
  const referral = await referralService.createFromBooking(req.doctorId, req.params.id, req.body);
  return created(res, serializeReferral(referral), "Referral sent");
});

/** GET /doctor/bookings/:id/referrals — referrals made from this consult. */
exports.listForBooking = asyncHandler(async (req, res) => {
  const rows = await referralService.listForBookingPatient(req.doctorId, req.params.id);
  return ok(res, rows.map(serializeReferral), "Referrals");
});

/** GET /doctor/referral-targets?q=&clinicId= — the name autocomplete. */
exports.listTargets = asyncHandler(async (req, res) => {
  const rows = await referralService.listTargets(req.doctorId, req.validatedQuery);
  return ok(res, rows.map(serializeReferralTarget), "Referral targets");
});

/** PATCH /doctor/referrals/:id — cancel a still-pending referral. */
exports.cancel = asyncHandler(async (req, res) => {
  const referral = await referralService.cancel(req.doctorId, req.params.id);
  return ok(res, serializeReferral(referral), "Referral cancelled");
});

// ── Target-doctor side: "who referred a patient TO me" ───────────────────────
/** GET /doctor/referrals/incoming — the inbox of referrals sent to this doctor. */
exports.listIncoming = asyncHandler(async (req, res) => {
  const rows = await referralService.listIncoming(req.doctorId, { status: req.query.status });
  return ok(res, rows.map(serializeIncomingReferral), "Incoming referrals");
});

/** GET /doctor/referrals/:id/case — the referring doctor's notes + prescription. */
exports.getCase = asyncHandler(async (req, res) => {
  const data = await referralService.getIncomingCase(req.doctorId, req.params.id);
  return ok(res, serializeReferralCase(data), "Referral case");
});

/** GET /doctor/referrals/:id/case/prescription.pdf — stream the referring Rx PDF. */
exports.caseRxPdf = asyncHandler(async (req, res) => {
  const bookingId = await referralService.sourceBookingForIncoming(req.doctorId, req.params.id);
  const result = await prescriptionService.getPdfForBooking(bookingId);
  return streamPdf(res, result);
});

/**
 * POST /doctor/referrals/:id/consultation — the target doctor begins the walk-in
 * consult (creates their ₹0 appointment). Returns `{ bookingId }` so the UI opens
 * the ordinary appointment screen for it.
 */
exports.startConsultation = asyncHandler(async (req, res) => {
  const result = await referralService.startConsultation(req.doctorId, req.params.id);
  return created(res, result, "Consultation started");
});
