/**
 * Doctor-owned profile & portfolio controllers — deliberately THIN. Each handler
 * reads validated input + `req.doctorId`, calls exactly one service function, and
 * serializes the result. No business rules, no DB calls, no validation here.
 */
const doctorService = require("../services/doctor.service");
const verificationService = require("../services/verification.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeDoctorProfile,
  serializePublicDoctor,
  serializeSubSpecialization,
  serializeUser,
  serializeAward,
  serializeLink,
  serializeKeyword,
  serializeDocument,
  serializeEducation,
  serializeExperience,
  serializeService,
  serializePublication,
  serializeMembership,
  serializeFaq,
  serializeGalleryImage,
  serializeTestimonial,
  serializeAffiliation,
  serializeFellowship,
  serializeExpertise,
} = require("../utils/serializers");

// ── Onboarding + profile ─────────────────────────────────────────────────────
exports.onboarding = asyncHandler(async (req, res) => {
  const status = await verificationService.getOnboarding(req.doctorId);
  return ok(res, status, "Onboarding status");
});

exports.getProfile = asyncHandler(async (req, res) => {
  const profile = await doctorService.getOwnProfile(req.doctorId);
  return ok(res, serializeDoctorProfile(profile), "Your profile");
});

/**
 * The doctor's OWN profile in the PUBLIC shape — "how patients will see me".
 * Same serializer as GET /doctors/:slug, but off the doctor's own row and at
 * ANY verification status, so they can preview before going live.
 */
exports.preview = asyncHandler(async (req, res) => {
  const profile = await doctorService.getOwnProfile(req.doctorId);
  return ok(res, serializePublicDoctor(profile), "Portfolio preview");
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const profile = await doctorService.updateProfile(req.doctorId, req.body);
  return ok(res, serializeDoctorProfile(profile), "Profile updated");
});

exports.setSpecializations = asyncHandler(async (req, res) => {
  const profile = await doctorService.setSpecializations(req.doctorId, req.body.specializationIds);
  return ok(res, serializeDoctorProfile(profile), "Specializations updated");
});

exports.setSubSpecializations = asyncHandler(async (req, res) => {
  const profile = await doctorService.setSubSpecializations(req.doctorId, req.body.subSpecializationIds);
  return ok(res, serializeDoctorProfile(profile), "Sub-specializations updated");
});

/** Find-or-create a shared catalog sub-specialty: 201 when new, 200 when it existed. */
exports.createSubSpecialization = asyncHandler(async (req, res) => {
  const { subSpecialization, created: isNew } = await doctorService.createSubSpecialization(req.body);
  const data = serializeSubSpecialization(subSpecialization);
  return isNew ? created(res, data, "Sub-specialization added") : ok(res, data, "Sub-specialization already exists");
});

exports.setLanguages = asyncHandler(async (req, res) => {
  const profile = await doctorService.setLanguages(req.doctorId, req.body.languageIds);
  return ok(res, serializeDoctorProfile(profile), "Languages updated");
});

// ── Awards ───────────────────────────────────────────────────────────────────
exports.listAwards = asyncHandler(async (req, res) => {
  const rows = await doctorService.listAwards(req.doctorId);
  return ok(res, rows.map(serializeAward), "Awards");
});
exports.addAward = asyncHandler(async (req, res) => {
  const row = await doctorService.addAward(req.doctorId, req.body);
  return created(res, serializeAward(row), "Award added");
});
exports.updateAward = asyncHandler(async (req, res) => {
  const row = await doctorService.updateAward(req.doctorId, req.params.id, req.body);
  return ok(res, serializeAward(row), "Award updated");
});
exports.uploadAwardImage = asyncHandler(async (req, res) => {
  const row = await doctorService.uploadAwardImage(req.doctorId, req.params.id, req.file);
  return ok(res, serializeAward(row), "Award image saved");
});
exports.removeAwardImage = asyncHandler(async (req, res) => {
  const row = await doctorService.removeAwardImage(req.doctorId, req.params.id);
  return ok(res, serializeAward(row), "Award image removed");
});
exports.removeAward = asyncHandler(async (req, res) => {
  await doctorService.removeAward(req.doctorId, req.params.id);
  return ok(res, null, "Award removed");
});

// ── Links ────────────────────────────────────────────────────────────────────
exports.listLinks = asyncHandler(async (req, res) => {
  const rows = await doctorService.listLinks(req.doctorId);
  return ok(res, rows.map(serializeLink), "Links");
});
exports.addLink = asyncHandler(async (req, res) => {
  const row = await doctorService.addLink(req.doctorId, req.body);
  return created(res, serializeLink(row), "Link added");
});
exports.removeLink = asyncHandler(async (req, res) => {
  await doctorService.removeLink(req.doctorId, req.params.id);
  return ok(res, null, "Link removed");
});

// ── Keywords ─────────────────────────────────────────────────────────────────
exports.listKeywords = asyncHandler(async (req, res) => {
  const rows = await doctorService.listKeywords(req.doctorId);
  return ok(res, rows.map(serializeKeyword), "Keywords");
});
exports.addKeyword = asyncHandler(async (req, res) => {
  const row = await doctorService.addKeyword(req.doctorId, req.body);
  return created(res, serializeKeyword(row), "Keyword added");
});
exports.removeKeyword = asyncHandler(async (req, res) => {
  await doctorService.removeKeyword(req.doctorId, req.params.id);
  return ok(res, null, "Keyword removed");
});

// ── Documents ────────────────────────────────────────────────────────────────
exports.listDocuments = asyncHandler(async (req, res) => {
  const rows = await doctorService.listDocuments(req.doctorId);
  return ok(res, rows.map(serializeDocument), "Documents");
});
exports.uploadDocument = asyncHandler(async (req, res) => {
  const row = await doctorService.addDocument(req.doctorId, req.body.docType, req.file);
  return created(res, serializeDocument(row), "Document uploaded");
});
exports.removeDocument = asyncHandler(async (req, res) => {
  await doctorService.removeDocument(req.doctorId, req.params.id);
  return ok(res, null, "Document removed");
});

// ── Photo + submit ───────────────────────────────────────────────────────────
exports.uploadPhoto = asyncHandler(async (req, res) => {
  const user = await doctorService.uploadPhoto(req.doctorId, req.file);
  return ok(res, serializeUser(user), "Photo updated");
});

// ── Showcase image (the "Why Choose <name>" section picture) ─────────────────
exports.uploadShowcaseImage = asyncHandler(async (req, res) => {
  const url = await doctorService.uploadShowcaseImage(req.doctorId, req.file);
  return ok(res, { showcaseImageUrl: url }, "Showcase image updated");
});
exports.removeShowcaseImage = asyncHandler(async (req, res) => {
  await doctorService.removeShowcaseImage(req.doctorId);
  return ok(res, { showcaseImageUrl: null }, "Showcase image removed");
});

// ── Portfolio hero images (up to three background pictures) ─────────────────
exports.uploadHeroImage = asyncHandler(async (req, res) => {
  const urls = await doctorService.uploadHeroImage(req.doctorId, req.file, req.body.slot);
  return ok(res, { heroImageUrls: urls }, "Hero image saved");
});
exports.removeHeroImage = asyncHandler(async (req, res) => {
  const urls = await doctorService.removeHeroImage(req.doctorId, req.params.index);
  return ok(res, { heroImageUrls: urls }, "Hero image removed");
});

exports.submit = asyncHandler(async (req, res) => {
  const status = await verificationService.submit(req.doctorId);
  return ok(res, status, "Submitted for verification");
});

// ── Portfolio v2 sections ─────────────────────────────────────────────────────
/**
 * Build the {list,add,update,remove} handlers for one generic owned resource
 * (education/experience/services/publications/memberships/faqs) — one factory
 * instead of 24 near-identical handlers. `key` selects the model in the service.
 */
function ownedHandlers(key, serialize, label) {
  return {
    list: asyncHandler(async (req, res) => {
      const rows = await doctorService.listOwned(key, req.doctorId);
      return ok(res, rows.map(serialize), label);
    }),
    add: asyncHandler(async (req, res) => {
      const row = await doctorService.addOwned(key, req.doctorId, req.body);
      return created(res, serialize(row), `${label} added`);
    }),
    update: asyncHandler(async (req, res) => {
      const row = await doctorService.updateOwned(key, req.doctorId, req.params.id, req.body);
      return ok(res, serialize(row), `${label} updated`);
    }),
    remove: asyncHandler(async (req, res) => {
      await doctorService.removeOwned(key, req.doctorId, req.params.id);
      return ok(res, null, `${label} removed`);
    }),
  };
}

exports.education = ownedHandlers("education", serializeEducation, "Education");
exports.experience = ownedHandlers("experience", serializeExperience, "Experience");
exports.services = ownedHandlers("services", serializeService, "Service");
exports.publications = ownedHandlers("publications", serializePublication, "Publication");
exports.memberships = ownedHandlers("memberships", serializeMembership, "Membership");
exports.faqs = ownedHandlers("faqs", serializeFaq, "FAQ");
exports.testimonials = ownedHandlers("testimonials", serializeTestimonial, "Testimonial");
// Migration 049 sections.
exports.affiliations = ownedHandlers("affiliations", serializeAffiliation, "Affiliation");
exports.fellowships = ownedHandlers("fellowships", serializeFellowship, "Fellowship");
exports.expertise = ownedHandlers("expertise", serializeExpertise, "Expertise");

// Testimonial extras: the consented patient photo + manual ordering.
exports.uploadTestimonialPhoto = asyncHandler(async (req, res) => {
  const row = await doctorService.uploadTestimonialPhoto(req.doctorId, req.params.id, req.file);
  return ok(res, serializeTestimonial(row), "Photo saved");
});
exports.removeTestimonialPhoto = asyncHandler(async (req, res) => {
  const row = await doctorService.removeTestimonialPhoto(req.doctorId, req.params.id);
  return ok(res, serializeTestimonial(row), "Photo removed");
});
exports.reorderTestimonials = asyncHandler(async (req, res) => {
  const rows = await doctorService.reorderTestimonials(req.doctorId, req.body.ids);
  return ok(res, rows.map(serializeTestimonial), "Testimonials reordered");
});

// Gallery (image upload) + insurances (M:N) are explicit — they don't fit the
// generic owned-CRUD shape.
exports.listGallery = asyncHandler(async (req, res) => {
  const rows = await doctorService.listGallery(req.doctorId);
  return ok(res, rows.map(serializeGalleryImage), "Gallery");
});
exports.addGallery = asyncHandler(async (req, res) => {
  const row = await doctorService.addGalleryImage(req.doctorId, req.file, req.body);
  return created(res, serializeGalleryImage(row), "Image added");
});
exports.updateGallery = asyncHandler(async (req, res) => {
  const row = await doctorService.updateGalleryImage(req.doctorId, req.params.id, req.body);
  return ok(res, serializeGalleryImage(row), "Image updated");
});
exports.reorderGallery = asyncHandler(async (req, res) => {
  const rows = await doctorService.reorderGallery(req.doctorId, req.body.ids);
  return ok(res, rows.map(serializeGalleryImage), "Gallery reordered");
});
exports.removeGallery = asyncHandler(async (req, res) => {
  await doctorService.removeGalleryImage(req.doctorId, req.params.id);
  return ok(res, null, "Image removed");
});

exports.setInsurances = asyncHandler(async (req, res) => {
  const profile = await doctorService.setInsurances(req.doctorId, req.body.insuranceIds);
  return ok(res, serializeDoctorProfile(profile), "Insurances updated");
});
