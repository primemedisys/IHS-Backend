/**
 * The completeness engine + submit guard + admin verdict + public reads — all in
 * ONE place so the `GET /doctor/onboarding` checklist and the `POST /doctor/submit`
 * guard are computed by the SAME function and can never diverge (README §5.1).
 */
const { DoctorProfile, Specialization, SubSpecialization, Language } = require("../models");
const ApiError = require("../utils/ApiError");
const {
  ERROR_CODES,
  REQUIRED_DOC_TYPES,
  ONBOARDING_REQUIRED_STEPS,
  DOCTOR_PAGE_SIZE_DEFAULT,
  DOCTOR_MAP_LIMIT,
  DOCTOR_RELATED_LIMIT,
} = require("../config/constants");
const doctorService = require("./doctor.service");
const doctorSearch = require("./doctorSearch.service");
const { parseDoctorId } = require("../utils/slug");
const { serializePublicDoctor, toMapDoctor } = require("../utils/serializers");

/**
 * The single source of truth for "what's done". `profile` must already be eager
 * loaded (doctorService.fullInclude). Deferred steps return `null` so the
 * frontend renders them as "coming next" and they're excluded from canSubmit.
 */
function computeChecklist(profile) {
  const documents = profile.documents || [];
  // Clinics & availability (PRD §4.3a): a clinic is "real" when active; the
  // doctor is available when they offer ≥1 window ANYWHERE — an active clinic
  // slot OR an online slot (a clinic-only or video-only doctor both pass).
  const activeClinics = (profile.clinics || []).filter((c) => c.isActive);
  const hasClinicSlot = activeClinics.some((c) =>
    (c.availability || []).some((a) => a.isActive)
  );
  const hasOnlineSlot = (profile.onlineAvailability || []).some((a) => a.isActive);
  // Public contact: an explicit public field OR a fallback to the account's.
  const contactOk = Boolean(
    (profile.publicPhone || profile.user?.phone) && (profile.publicEmail || profile.user?.email)
  );
  return {
    professional: Boolean(
      profile.qualification &&
        profile.experienceYears >= 0 &&
        profile.registrationNumber &&
        !profile.registrationNumber.startsWith("PENDING-")
    ),
    specialties: (profile.specializations || []).length >= 1,
    // Portfolio v2 core (docs/doctor-portfolio-v2 §3): hero + about + photo +
    // public contact + ≥1 education/service/experience. Optional sections
    // (publications/gallery/faqs/insurance/memberships) are NOT gated — to
    // change the tier, edit only this predicate.
    portfolio: Boolean(
      profile.bio &&
        profile.headline &&
        profile.gender &&
        profile.user &&
        profile.user.profilePhotoUrl &&
        contactOk &&
        (profile.education || []).length >= 1 &&
        (profile.services || []).length >= 1 &&
        (profile.experience || []).length >= 1
    ),
    documents: REQUIRED_DOC_TYPES.every((t) => documents.some((d) => d.docType === t)),
    clinics: activeClinics.length >= 1,
    availability: hasClinicSlot || hasOnlineSlot,
    // Bank/payout stays deferred (payments plan) — not in ONBOARDING_REQUIRED_STEPS.
    bank: null,
  };
}

/** True only when every REQUIRED step is complete. */
const canSubmit = (steps) => ONBOARDING_REQUIRED_STEPS.every((step) => steps[step] === true);

/** The wizard's brain: the checklist + submission/verification state. */
async function getOnboarding(userId) {
  const profile = await doctorService.getOwnProfile(userId);
  const steps = computeChecklist(profile);
  return {
    steps,
    canSubmit: canSubmit(steps),
    isSubmitted: Boolean(profile.isSubmitted),
    verificationStatus: profile.verificationStatus,
    verificationNotes: profile.verificationNotes ?? null,
  };
}

/**
 * Submit for verification. Re-computes the checklist server-side (authoritative)
 * and 422s if any required step is incomplete; otherwise flips is_submitted
 * (verification_status stays 'pending' until an admin decides).
 */
async function submit(userId) {
  const profile = await doctorService.getOwnProfile(userId);
  const steps = computeChecklist(profile);
  if (!canSubmit(steps)) {
    throw new ApiError(422, "Please complete all required steps before submitting", {
      code: ERROR_CODES.ONBOARDING_INCOMPLETE,
      details: { steps },
    });
  }
  await DoctorProfile.update({ isSubmitted: true }, { where: { userId } });
  return getOnboarding(userId);
}

// ── Admin verification ───────────────────────────────────────────────────────
const REVIEW_STATUSES = ["pending", "approved", "rejected"];

/**
 * Verification queue filtered by status. `status` comes straight off the query
 * string (Express 5 makes `req.query` read-only, so we don't run it through the
 * reassigning `validate` middleware) — normalize + whitelist it here, defaulting
 * to the pending queue.
 */
function listForReview(status) {
  const verificationStatus = REVIEW_STATUSES.includes(status) ? status : "pending";
  return DoctorProfile.findAll({
    where: { verificationStatus },
    include: doctorService.fullInclude,
    order: [["updatedAt", "DESC"]],
  });
}

/** One doctor's full profile + documents for review. */
const getForReview = (id) => doctorService.getOwnProfile(id);

/** Record an admin verdict: approve → live; reject → notes shown to the doctor. */
async function reviewDoctor(id, { decision, notes }) {
  const profile = await DoctorProfile.findByPk(id, { attributes: ["userId"] });
  if (!profile) throw ApiError.notFound("Doctor not found");
  await DoctorProfile.update(
    { verificationStatus: decision, verificationNotes: notes ?? null },
    { where: { userId: id } }
  );
  return doctorService.getOwnProfile(id);
}

/**
 * Flip the admin's public-visibility switch. Deliberately independent of the
 * verdict: un-listing is NOT a rejection (no notes, the doctor keeps their
 * account, their dashboard and every existing booking) — it only removes them
 * from the patient-facing reads gated by `doctorService.publicListingWhere`.
 */
async function setListing(id, isListed) {
  const profile = await DoctorProfile.findByPk(id, { attributes: ["userId"] });
  if (!profile) throw ApiError.notFound("Doctor not found");
  await DoctorProfile.update({ isListed }, { where: { userId: id } });
  return doctorService.getOwnProfile(id);
}

// ── Public reads ─────────────────────────────────────────────────────────────
/** Resolve a public portfolio by slug — only publicly listed doctors; else 404. */
async function getPublicBySlug(slug) {
  const id = parseDoctorId(slug);
  if (!id) throw ApiError.notFound("Doctor not found");
  const profile = await DoctorProfile.findByPk(id, { include: doctorService.fullInclude });
  if (!doctorService.isPubliclyListed(profile)) throw ApiError.notFound("Doctor not found");
  return profile;
}

/**
 * Public doctor discovery — approved doctors only, filtered/sorted/paginated in
 * SQL by `doctorSearch.service` (see that file for why this can't be a plain
 * `findAll` with a `limit`). `query` arrives already validated and coerced by
 * the `listDoctors` Joi schema, so there is nothing to normalize here.
 */
async function listPublicDoctors(query = {}) {
  const { rows, total } = await doctorSearch.search(query);
  const pageSize = query.pageSize ?? DOCTOR_PAGE_SIZE_DEFAULT;
  // Hand the location filter to the serializer so each card shows the clinic
  // that actually matched, not just the doctor's first one.
  const focus = { city: query.city, stateCode: query.stateCode };
  return {
    data: rows.map((row) => serializePublicDoctor(row, focus)),
    total,
    page: query.page ?? 1,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * All approved doctors that have a real clinic location, as lean markers for the
 * homepage hero + /map page. `hasLocation` drops un-located doctors in SQL, so
 * no null-island pin ever renders. Capped at DOCTOR_MAP_LIMIT — the map draws
 * every marker it is given in a single payload.
 */
async function listMapDoctors() {
  const { rows } = await doctorSearch.search({
    hasLocation: true,
    page: 1,
    pageSize: DOCTOR_MAP_LIMIT,
  });
  return rows.map((row) => toMapDoctor(serializePublicDoctor(row)));
}

/**
 * Other approved doctors sharing the given doctor's PRIMARY specialty (for
 * "similar specialists"). Two bounded queries — the primary specialty, then the
 * page of peers — instead of loading the whole roster to return three cards.
 */
async function listRelatedDoctors(slug, limit = DOCTOR_RELATED_LIMIT) {
  const id = parseDoctorId(slug);
  if (!id) return [];

  const profile = await DoctorProfile.findByPk(id, {
    attributes: ["userId", ...doctorService.PUBLIC_LISTING_ATTRIBUTES],
    include: [{ model: Specialization, as: "specializations", through: { attributes: [] } }],
  });
  if (!doctorService.isPubliclyListed(profile)) return [];

  const primary = (profile.specializations || [])[0];
  if (!primary) return [];

  const { rows } = await doctorSearch.search({
    specialtySlug: primary.slug,
    excludeId: id,
    page: 1,
    pageSize: limit,
  });
  return rows.map((row) => serializePublicDoctor(row));
}

const listSpecializations = () => Specialization.findAll({ order: [["name", "ASC"]] });

const listSubSpecializations = (specializationId) =>
  SubSpecialization.findAll({
    where: specializationId ? { specializationId } : {},
    order: [["name", "ASC"]],
  });

const listLanguages = () => Language.findAll({ order: [["name", "ASC"]] });

module.exports = {
  computeChecklist,
  getOnboarding,
  submit,
  listForReview,
  getForReview,
  reviewDoctor,
  setListing,
  getPublicBySlug,
  listPublicDoctors,
  listMapDoctors,
  listRelatedDoctors,
  listSpecializations,
  listSubSpecializations,
  listLanguages,
};
