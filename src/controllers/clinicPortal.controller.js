/**
 * The clinic portal's own account surface: profile, onboarding checklist,
 * submit-for-verification and verification documents.
 *
 * Thin by convention — every handler reads validated input, calls exactly one
 * service function, and serializes. `req.user.id` IS the clinic id (the profile
 * table's PK is the FK to users).
 */
const clinicPortalService = require("../services/clinicPortal.service");
const uploadService = require("../services/upload.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const { serializeClinicProfile, serializeClinicDocument } = require("../utils/serializers");

exports.getProfile = asyncHandler(async (req, res) => {
  const profile = await clinicPortalService.getOwnProfile(req.user.id);
  return ok(res, serializeClinicProfile(profile), "Clinic profile");
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const profile = await clinicPortalService.updateOwnProfile(req.user.id, req.body);
  return ok(res, serializeClinicProfile(profile), "Profile updated");
});

exports.getOnboarding = asyncHandler(async (req, res) => {
  const state = await clinicPortalService.getOnboarding(req.user.id);
  return ok(res, state, "Onboarding status");
});

exports.submit = asyncHandler(async (req, res) => {
  const state = await clinicPortalService.submit(req.user.id);
  return ok(res, state, "Submitted for verification");
});

/**
 * Upload a verification document. The file arrives as multipart (`file`) and is
 * stored under a clinic-scoped key so one clinic's uploads can never collide
 * with another's.
 */
exports.uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("A file is required");

  const opts = { keyPrefix: `clinics/${req.user.id}/documents`, filename: req.file.originalname, mimetype: req.file.mimetype };
  const doc = await uploadService.storeThen(req.file.buffer, opts, (stored) =>
    clinicPortalService.addDocument(req.user.id, {
      docType: req.body.docType,
      fileUrl: stored.url,
      fileName: req.file.originalname,
      storageKey: stored.key,
    })
  );
  return created(res, serializeClinicDocument(doc), "Document uploaded");
});

exports.deleteDocument = asyncHandler(async (req, res) => {
  await clinicPortalService.removeDocument(req.user.id, req.params.documentId);
  return ok(res, null, "Document deleted");
});
