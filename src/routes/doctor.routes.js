/**
 * /doctor routes — the doctor's own profile & portfolio management. Every route
 * is guarded `authenticate` + `authorize('doctor')`. Validation and the upload
 * middleware are declared HERE so controllers stay thin.
 *
 * Upload order matters: `upload.single('file')` runs BEFORE `validate(...)` so
 * the multipart text field `req.body.docType` exists when Joi checks it.
 */
const router = require("express").Router();

const doctor = require("../controllers/doctor.controller");
const followUp = require("../controllers/followUp.controller");
const referral = require("../controllers/doctorReferral.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const upload = require("../middlewares/upload");
const schema = require("../validators/doctor.validator");
const paymentQr = require("../controllers/paymentQr.controller");
const paymentQrSchema = require("../validators/paymentQr.validator");
const followUpSchema = require("../validators/followUp.validator");
const referralSchema = require("../validators/referral.validator");
const { ROLES } = require("../config/constants");
const { subSpecCreateLimiter } = require("../middlewares/rateLimiters");

// resolveDoctorId('self') sets req.doctorId = req.user.id, so the shared
// controllers (also mounted under /admin/doctors/:doctorId/*) act on the owner.
const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router.get("/onboarding", ...guard, doctor.onboarding);

router.get("/profile", ...guard, doctor.getProfile);
router.patch("/profile", ...guard, validate(schema.updateProfile), doctor.updateProfile);

// Own profile in the public shape — "how patients see me" (any status).
router.get("/preview", ...guard, doctor.preview);

router.put("/specializations", ...guard, validate(schema.setSpecializations), doctor.setSpecializations);
router.put("/sub-specializations", ...guard, validate(schema.setSubSpecializations), doctor.setSubSpecializations);
// Shared catalog "+ Add new sub-specialty" (find-or-create; rate limited per doctor).
router.post(
  "/catalog/sub-specializations",
  ...guard,
  subSpecCreateLimiter,
  validate(schema.createSubSpecialization),
  doctor.createSubSpecialization
);
router.put("/languages", ...guard, validate(schema.setLanguages), doctor.setLanguages);

router
  .route("/awards")
  .all(...guard)
  .get(doctor.listAwards)
  .post(validate(schema.createAward), doctor.addAward);
router
  .route("/awards/:id")
  .all(...guard)
  .patch(validate(schema.partialOf(schema.createAward)), doctor.updateAward)
  .delete(doctor.removeAward);
// Optional award / certificate picture (migration 048).
router
  .route("/awards/:id/image")
  .all(...guard)
  .post(upload.single("file"), doctor.uploadAwardImage)
  .delete(doctor.removeAwardImage);

router
  .route("/links")
  .all(...guard)
  .get(doctor.listLinks)
  .post(validate(schema.createLink), doctor.addLink);
router.delete("/links/:id", ...guard, doctor.removeLink);

router
  .route("/keywords")
  .all(...guard)
  .get(doctor.listKeywords)
  .post(validate(schema.createKeyword), doctor.addKeyword);
router.delete("/keywords/:id", ...guard, doctor.removeKeyword);

router.get("/documents", ...guard, doctor.listDocuments);
router.post("/documents", ...guard, upload.single("file"), validate(schema.uploadDocument), doctor.uploadDocument);
router.delete("/documents/:id", ...guard, doctor.removeDocument);

router.post("/photo", ...guard, upload.single("file"), doctor.uploadPhoto);

// The "Why Choose <name>" section image on the public portfolio. DELETE
// reverts to the frontend's stock fallback.
router
  .route("/showcase-image")
  .all(...guard)
  .post(upload.single("file"), doctor.uploadShowcaseImage)
  .delete(doctor.removeShowcaseImage);

// Portfolio hero background images (1–3, migration 046). POST adds one, or
// replaces the image at `slot` when that slot is filled; DELETE drops one.
// Always the signed-in doctor's own row — no doctor id is accepted.
router.post(
  "/hero-images",
  ...guard,
  upload.single("file"),
  validate(schema.uploadHeroImage),
  doctor.uploadHeroImage
);
router.delete(
  "/hero-images/:index",
  ...guard,
  validate(schema.heroImageIndex, "params"),
  doctor.removeHeroImage
);

// The doctor's OWN consultation-payment UPI QR (migration 044). Always the
// signed-in doctor's row — no id in the path, none accepted in the body.
router
  .route("/payment-qr")
  .all(...guard)
  .get(paymentQr.get)
  .put(validate(paymentQrSchema.updatePaymentQr), paymentQr.update)
  .delete(paymentQr.remove);
router.post("/payment-qr/image", ...guard, upload.single("file"), paymentQr.uploadImage);

router.post("/submit", ...guard, doctor.submit);

// ── Portfolio v2 sections ─────────────────────────────────────────────────────
// The 6 generic owned resources share one route shape (list/create + patch/
// delete), wired from a key→createSchema map so adding the next section is a
// one-line entry. PATCH reuses the create schema made partial.
// Testimonial ordering is declared before the generic /:id routes below.
router.put("/testimonials/order", ...guard, validate(schema.reorderTestimonials), doctor.reorderTestimonials);
// The patient's photo: multipart, consent confirmed in the body (upload first
// so req.body.consent exists for validate).
router
  .route("/testimonials/:id/photo")
  .all(...guard)
  .post(upload.single("file"), validate(schema.testimonialPhoto), doctor.uploadTestimonialPhoto)
  .delete(doctor.removeTestimonialPhoto);

const OWNED_SECTIONS = {
  education: schema.createEducation,
  experience: schema.createExperience,
  services: schema.createService,
  publications: schema.createPublication,
  memberships: schema.createMembership,
  faqs: schema.createFaq,
  // Doctor-managed patient feedback (migration 048).
  testimonials: schema.createTestimonial,
  // Current affiliations, fellowships/training, expertise (migration 049).
  affiliations: schema.createAffiliation,
  fellowships: schema.createFellowship,
  expertise: schema.createExpertise,
};
for (const [key, createSchema] of Object.entries(OWNED_SECTIONS)) {
  const h = doctor[key];
  router
    .route(`/${key}`)
    .all(...guard)
    .get(h.list)
    .post(validate(createSchema), h.add);
  router
    .route(`/${key}/:id`)
    .all(...guard)
    .patch(validate(schema.partialOf(createSchema)), h.update)
    .delete(h.remove);
}

// Gallery (multipart: upload.single BEFORE validate so req.body.caption exists).
// `/order` is declared before `/:id` so it is never parsed as an id.
router.put("/gallery/order", ...guard, validate(schema.reorderGallery), doctor.reorderGallery);
router
  .route("/gallery")
  .all(...guard)
  .get(doctor.listGallery)
  .post(upload.single("file"), validate(schema.uploadGallery), doctor.addGallery);
router
  .route("/gallery/:id")
  .all(...guard)
  // Metadata only (title, caption, category, alt text, date).
  .patch(validate(schema.updateGallery), doctor.updateGallery)
  .delete(doctor.removeGallery);

// Accepted insurance (replace-the-set M:N).
router.put("/insurances", ...guard, validate(schema.setInsurances), doctor.setInsurances);

// ── Follow-up statuses (docs/follow-up-status) ───────────────────────────────
// The doctor's OWN category list — theirs to add to, rename, recolour, reorder
// and delete. `/reorder` is declared before `/:id` so it is never parsed as one.
router
  .route("/follow-up-statuses")
  .all(...guard)
  .get(followUp.listStatuses)
  .post(validate(followUpSchema.createStatus), followUp.createStatus);
router.put(
  "/follow-up-statuses/reorder",
  ...guard,
  validate(followUpSchema.reorderStatuses),
  followUp.reorderStatuses
);
router
  .route("/follow-up-statuses/:id")
  .all(...guard)
  .patch(validate(followUpSchema.updateStatus), followUp.updateStatus)
  // 409s while patients still carry it — archiving (PATCH isActive:false) is
  // the way to retire one that is in use.
  .delete(followUp.deleteStatus);

// ONE CONSULTATION'S follow-up: the status decided at that visit and the date
// the patient is expected back. Keyed on the booking, so re-tagging one visit
// leaves that patient's other visits alone.
router
  .route("/bookings/:id/follow-up")
  .all(...guard)
  .get(followUp.getBookingFollowUp)
  .put(validate(followUpSchema.setFollowUp), followUp.setBookingFollowUp)
  .delete(followUp.clearBookingFollowUp);

// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────
const followUpReminder = require("../controllers/followUpReminder.controller");
const followUpReminderSchema = require("../validators/followUpReminder.validator");

router
  .route("/bookings/:id/reminder")
  .all(...guard)
  .get(followUpReminder.getReminder)
  .put(validate(followUpReminderSchema.setReminder), followUpReminder.setReminder)
  .delete(followUpReminder.cancelReminder);

// ── Multi-doctor referrals (docs/multi-doctor-referrals) ─────────────────────
// The name-autocomplete lookup + cancelling a still-pending referral. (Creating
// and listing referrals off a booking live in doctorBooking.routes.js.)
router.get("/referral-targets", ...guard, validateQuery(referralSchema.listTargets), referral.listTargets);
// Target-doctor inbox: referrals sent TO me + the shared case (source notes + Rx).
// `/incoming` is declared before `/:id/…` so it's never parsed as an :id.
router.get("/referrals/incoming", ...guard, referral.listIncoming);
router.get("/referrals/:id/case", ...guard, referral.getCase);
router.get("/referrals/:id/case/prescription.pdf", ...guard, referral.caseRxPdf);
// The target doctor begins the walk-in consult → creates their ₹0 appointment.
router.post("/referrals/:id/consultation", ...guard, referral.startConsultation);
router.patch("/referrals/:id", ...guard, validate(referralSchema.cancelReferral), referral.cancel);

module.exports = router;
