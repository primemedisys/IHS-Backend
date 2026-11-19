/**
 * Public (no-auth) doctor discovery reads: the portfolio page + the lookup lists
 * that feed the specialty/language pickers and discovery filters. Thin wrappers
 * over verification.service reads.
 */
const verificationService = require("../services/verification.service");
const doctorService = require("../services/doctor.service");
const bookingService = require("../services/booking.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const {
  serializePublicDoctor,
  serializeSpecialization,
  serializeSubSpecialization,
  serializeLanguage,
  serializeInsurance,
} = require("../utils/serializers");

/** Which payment choices the booking screen may offer (migration 044). */
exports.paymentOptions = asyncHandler(async (req, res) =>
  ok(res, await bookingService.paymentOptionsForDoctor(req.params.id), "Payment options")
);

exports.getBySlug = asyncHandler(async (req, res) => {
  const profile = await verificationService.getPublicBySlug(req.params.slug);
  return ok(res, serializePublicDoctor(profile), "Doctor profile");
});

/**
 * Public discovery list — approved doctors, filtered/sorted/paginated in SQL.
 * `req.validatedQuery` is produced by the `validateQuery` middleware (Express 5
 * makes `req.query` read-only, so the coerced value lands there instead).
 */
exports.listDoctors = asyncHandler(async (req, res) => {
  const result = await verificationService.listPublicDoctors(req.validatedQuery);
  return ok(res, result, "Doctors");
});

/**
 * Public map list — all approved, located doctors as lean markers for the
 * homepage hero + /map page. No params: the client filters by specialty and
 * sorts by distance over the returned set.
 */
exports.listMapDoctors = asyncHandler(async (_req, res) => {
  const rows = await verificationService.listMapDoctors();
  return ok(res, rows, "Map doctors");
});

exports.related = asyncHandler(async (req, res) => {
  const rows = await verificationService.listRelatedDoctors(req.params.slug);
  return ok(res, rows, "Related doctors");
});

exports.listSpecializations = asyncHandler(async (_req, res) => {
  const rows = await verificationService.listSpecializations();
  return ok(res, rows.map(serializeSpecialization), "Specializations");
});

exports.listSubSpecializations = asyncHandler(async (req, res) => {
  const specializationId = req.query.specializationId;
  const rows = await verificationService.listSubSpecializations(specializationId);
  return ok(res, rows.map(serializeSubSpecialization), "Sub-specializations");
});

exports.listLanguages = asyncHandler(async (_req, res) => {
  const rows = await verificationService.listLanguages();
  return ok(res, rows.map(serializeLanguage), "Languages");
});

exports.listInsurances = asyncHandler(async (_req, res) => {
  const rows = await doctorService.listInsurances();
  return ok(res, rows.map(serializeInsurance), "Insurances");
});
