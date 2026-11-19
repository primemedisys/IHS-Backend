/**
 * The clinic ACCOUNT: its own profile, onboarding checklist, verification
 * paperwork and the admin verdict.
 *
 * Named `clinicPortal.*` because `clinic.service.js` already exists and means
 * something else entirely — a doctor's physical location (`clinics`, NOT NULL
 * doctor_id). This file is about the organisation that logs in.
 *
 * Mirrors verification.service.js on purpose: the checklist shown by
 * `GET /clinic/onboarding` and the guard inside `POST /clinic/submit` are the
 * SAME function, so they can never drift.
 */
const { ClinicProfile, ClinicDocument, User } = require("../models");
const ApiError = require("../utils/ApiError");
const {
  ERROR_CODES,
  CLINIC_REQUIRED_DOC_TYPES,
  CLINIC_ONBOARDING_REQUIRED_STEPS,
} = require("../config/constants");
const uploadService = require("./upload.service");

/** Eager-load spec: the profile plus its account and paperwork, in one query. */
const fullInclude = [
  { model: User, as: "user", attributes: ["id", "name", "email", "phone", "profilePhotoUrl"] },
  { model: ClinicDocument, as: "documents" },
];

/** The clinic's own profile row, with account + documents. 404 if missing. */
async function getOwnProfile(userId) {
  let profile = await ClinicProfile.findByPk(userId, { include: fullInclude });
  // Defensive: auto-create the profile row if it's missing (e.g. the user was
  // created before migration 017 ran, or the profile creation failed silently).
  if (!profile) {
    const user = await User.findByPk(userId, { attributes: ["id", "name", "phone"] });
    if (!user) throw ApiError.notFound("User not found");
    await ClinicProfile.create({ userId: user.id, clinicName: user.name, phone: user.phone || null });
    profile = await ClinicProfile.findByPk(userId, { include: fullInclude });
  }
  if (!profile) throw ApiError.notFound("Clinic profile not found");
  return profile;
}

/**
 * The single source of truth for "what's done". `profile` must already be
 * eager-loaded via `fullInclude`.
 *
 * `location` requires BOTH a postal address and map coordinates — a patient
 * being sent to this clinic needs to be able to find it, and the doctor's
 * appointment list shows the city.
 */
function computeChecklist(profile) {
  const documents = profile.documents || [];
  return {
    profile: Boolean(
      profile.clinicName && (profile.phone || profile.user?.phone) && profile.registrationNumber
    ),
    location: Boolean(
      profile.addressLine &&
        profile.city &&
        profile.state &&
        profile.pincode &&
        profile.lat !== null &&
        profile.lng !== null
    ),
    documents: CLINIC_REQUIRED_DOC_TYPES.every((t) => documents.some((d) => d.docType === t)),
  };
}

/** True only when every REQUIRED step is complete. */
const canSubmit = (steps) => CLINIC_ONBOARDING_REQUIRED_STEPS.every((step) => steps[step] === true);

/** The wizard's brain: checklist + submission/verification state. */
async function getOnboarding(userId) {
  const profile = await getOwnProfile(userId);
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
 * Update the clinic's own profile. Only whitelisted columns are writable — in
 * particular `verificationStatus`, `isSubmitted` and `isActive` are NOT, so a
 * clinic can never approve itself by PUTing its own profile.
 */
const WRITABLE = [
  "clinicName",
  "registrationNumber",
  "phone",
  "addressLine",
  "city",
  "state",
  "pincode",
  "lat",
  "lng",
  "logoUrl",
  "about",
];

async function updateOwnProfile(userId, patch) {
  const fields = {};
  for (const key of WRITABLE) {
    if (patch[key] !== undefined) fields[key] = patch[key];
  }
  if (Object.keys(fields).length) {
    await ClinicProfile.update(fields, { where: { userId } });
  }
  return getOwnProfile(userId);
}

/**
 * Submit for verification. Re-computes the checklist server-side (authoritative)
 * and 422s if anything required is missing; otherwise flips is_submitted —
 * verification_status stays 'pending' until an admin decides.
 */
async function submit(userId) {
  const profile = await getOwnProfile(userId);
  const steps = computeChecklist(profile);
  if (!canSubmit(steps)) {
    throw new ApiError(422, "Please complete all required steps before submitting", {
      code: ERROR_CODES.ONBOARDING_INCOMPLETE,
      details: { steps },
    });
  }
  await ClinicProfile.update({ isSubmitted: true }, { where: { userId } });
  return getOnboarding(userId);
}

// ── Verification documents ───────────────────────────────────────────────────

/** Record an uploaded document against the clinic. */
async function addDocument(userId, { docType, fileUrl, fileName, storageKey }) {
  await ClinicProfile.findByPk(userId, { attributes: ["userId"] }).then((p) => {
    if (!p) throw ApiError.notFound("Clinic profile not found");
  });
  const row = await ClinicDocument.create({
    clinicId: userId,
    docType,
    fileUrl,
    fileName: fileName ?? null,
    storageKey: storageKey ?? null,
  });
  return row;
}

/**
 * Delete a document — scoped to the owning clinic, so passing another clinic's
 * document id 404s rather than deleting it. The stored file goes too.
 */
async function removeDocument(userId, documentId) {
  const row = await ClinicDocument.findOne({ where: { id: documentId, clinicId: userId } });
  if (!row) throw ApiError.notFound("Document not found");

  const key = row.storageKey || uploadService.keyFromUrl(row.fileUrl);
  await row.destroy();
  // Best-effort: the row is already gone, and a stray object is better than a
  // failed request that leaves the clinic unable to re-upload.
  if (key) {
    try {
      await uploadService.remove(key);
    } catch {
      /* ignore */
    }
  }
  return true;
}

// ── Admin verification ───────────────────────────────────────────────────────
const REVIEW_STATUSES = ["pending", "approved", "rejected"];

/**
 * The admin queue, filtered by status. `status` comes straight off the query
 * string (Express 5 makes `req.query` read-only) — normalized and whitelisted
 * here, defaulting to the pending queue.
 */
function listForReview(status) {
  const verificationStatus = REVIEW_STATUSES.includes(status) ? status : "pending";
  return ClinicProfile.findAll({
    where: { verificationStatus },
    include: fullInclude,
    order: [["updatedAt", "DESC"]],
  });
}

/** One clinic's full profile + documents, for review. */
const getForReview = (id) => getOwnProfile(id);

/** Record an admin verdict: approve → the clinic can reach patient data. */
async function reviewClinic(id, { decision, notes }) {
  const profile = await ClinicProfile.findByPk(id, { attributes: ["userId"] });
  if (!profile) throw ApiError.notFound("Clinic not found");
  await ClinicProfile.update(
    { verificationStatus: decision, verificationNotes: notes ?? null },
    { where: { userId: id } }
  );
  return getOwnProfile(id);
}

/**
 * Suspend / reinstate an approved clinic without rejecting it. Independent of
 * the verdict, mirroring the doctor listing toggle: the account and its history
 * survive, but every patient route stops answering.
 */
async function setActive(id, isActive) {
  const profile = await ClinicProfile.findByPk(id, { attributes: ["userId"] });
  if (!profile) throw ApiError.notFound("Clinic not found");
  await ClinicProfile.update({ isActive }, { where: { userId: id } });
  return getOwnProfile(id);
}

module.exports = {
  fullInclude,
  getOwnProfile,
  computeChecklist,
  getOnboarding,
  updateOwnProfile,
  submit,
  addDocument,
  removeDocument,
  listForReview,
  getForReview,
  reviewClinic,
  setActive,
};
