/**
 * Doctor-owned profile & portfolio business logic. All DB access for the
 * `/doctor/*` surface lives here; controllers stay thin. Relations are eager
 * loaded with `include` (never queried in a loop), multi-row set replacements
 * run inside a transaction, and user-shaped queries reuse user.service.
 */
const { Op, UniqueConstraintError } = require("sequelize");
const {
  sequelize,
  User,
  DoctorProfile,
  Specialization,
  SubSpecialization,
  Language,
  DoctorSpecialization,
  DoctorSubSpecialization,
  DoctorLanguage,
  DoctorAward,
  DoctorTestimonial,
  DoctorLink,
  DoctorDocument,
  DoctorSearchKeyword,
  DoctorEducation,
  DoctorExperience,
  DoctorService,
  DoctorPublication,
  DoctorMembership,
  DoctorGallery,
  DoctorFaq,
  DoctorAffiliation,
  DoctorFellowship,
  DoctorExpertise,
  Insurance,
  DoctorInsurance,
  Clinic,
  ClinicAvailability,
  DoctorOnlineAvailability,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { subSpecSlug } = require("../utils/slug");
const { ERROR_CODES } = require("../config/constants");
const uploadService = require("./upload.service");
const { MAX_HERO_IMAGES, heroImageList } = require("../utils/heroImages");

/**
 * The eager-load spec for a doctor's FULL profile (own draft or public read).
 * Kept in one place so `getOwnProfile`, the onboarding checklist, and the public
 * route all load the exact same relations in a single query.
 */
// `separate: true` on every hasMany relation is deliberate and load-bearing.
// Without it, LEFT JOINing ~13 one-to-many lists in ONE query produces a
// cartesian product (rows multiply across every list), which balloons to
// hundreds of thousands of rows for a single doctor, holds the DB connection
// for seconds, and — under repeated requests — exhausts the pool
// (ConnectionAcquireTimeoutError). `separate` runs each list as its own fast
// `WHERE doctor_id IN (...)` query instead. Only hasMany supports it; the
// belongsToMany sets (specializations/languages/insurances) stay as JOINs
// since they're small and can't use `separate`.
const fullInclude = [
  { model: User, as: "user", attributes: ["id", "name", "email", "phone", "profilePhotoUrl"] },
  { model: Specialization, as: "specializations", through: { attributes: [] } },
  { model: SubSpecialization, as: "subSpecializations", through: { attributes: [] } },
  { model: Language, as: "languages", through: { attributes: [] } },
  { model: DoctorAward, as: "awards", separate: true },
  // Doctor-managed testimonials (migration 048); the public serializer keeps
  // only the visible ones.
  { model: DoctorTestimonial, as: "testimonials", separate: true },
  { model: DoctorLink, as: "links", separate: true },
  { model: DoctorDocument, as: "documents", separate: true },
  { model: DoctorSearchKeyword, as: "keywords", separate: true },
  // Portfolio v2 sections (docs/doctor-portfolio-v2). All ordered lists.
  { model: DoctorEducation, as: "education", separate: true },
  { model: DoctorExperience, as: "experience", separate: true },
  { model: DoctorService, as: "services", separate: true },
  { model: DoctorPublication, as: "publications", separate: true },
  { model: DoctorMembership, as: "memberships", separate: true },
  { model: DoctorGallery, as: "gallery", separate: true },
  { model: DoctorFaq, as: "faqs", separate: true },
  // Affiliations / fellowships / expertise (migration 049).
  { model: DoctorAffiliation, as: "affiliations", separate: true },
  { model: DoctorFellowship, as: "fellowships", separate: true },
  { model: DoctorExpertise, as: "expertise", separate: true },
  { model: Insurance, as: "insurances", through: { attributes: [] } },
  // Clinics + their weekly slots, and the independent online schedule. Loaded
  // here so the onboarding checklist, the owner profile, and the public read all
  // get them in one query (docs/clinics-availability).
  {
    model: Clinic,
    as: "clinics",
    separate: true,
    include: [{ model: ClinicAvailability, as: "availability" }],
  },
  { model: DoctorOnlineAvailability, as: "onlineAvailability", separate: true },
];

/**
 * A LEAN include for discovery cards — only what a list card renders (identity,
 * specialties, languages, clinics+fees, online slots). Skips the heavy portfolio
 * sections so listing many doctors stays cheap. serializePublicDoctor guards
 * every omitted relation with `|| []`, so the card shape still serializes.
 */
const cardInclude = [
  { model: User, as: "user", attributes: ["id", "name", "profilePhotoUrl"] },
  { model: Specialization, as: "specializations", through: { attributes: [] } },
  { model: Language, as: "languages", through: { attributes: [] } },
  {
    model: Clinic,
    as: "clinics",
    separate: true,
    include: [{ model: ClinicAvailability, as: "availability" }],
  },
  { model: DoctorOnlineAvailability, as: "onlineAvailability", separate: true },
];

// ── "Is this doctor live to patients?" — ONE definition ──────────────────────
//
// Two independent gates, and both must pass:
//   • verification_status = 'approved'  — the admin vetted them;
//   • is_listed = 1                     — the admin's visibility toggle
//                                         (migration 014) is on.
// Every patient-facing read gates on this and nothing else, so flipping the
// toggle removes a doctor from discovery, the map, their portfolio page,
// related-doctor rails, slot previews AND new bookings in one shot. Existing
// bookings are untouched — those read the booking row, not this predicate.

/** Sequelize `where` fragment for a publicly listed doctor. */
const publicListingWhere = { verificationStatus: "approved", isListed: true };

/**
 * The same predicate in raw SQL, for `doctorSearch.service`. `alias` is the
 * `doctor_profiles` table alias in the caller's statement.
 */
const publicListingSql = (alias = "p") =>
  `${alias}.verification_status = 'approved' AND ${alias}.is_listed = 1`;

/**
 * The same predicate against an already-loaded row. The row's `attributes` MUST
 * include both columns — a projection that omits `isListed` reads `undefined`
 * and correctly fails closed rather than leaking a hidden doctor.
 */
const isPubliclyListed = (profile) =>
  Boolean(profile) && profile.verificationStatus === "approved" && Boolean(profile.isListed);

/** Attributes any lean visibility check must select for `isPubliclyListed`. */
const PUBLIC_LISTING_ATTRIBUTES = ["verificationStatus", "isListed"];

/** Load a doctor's own profile with every relation, in ONE query. */
async function getOwnProfile(userId) {
  const profile = await DoctorProfile.findByPk(userId, { include: fullInclude });
  if (!profile) throw ApiError.notFound("Doctor profile not found");
  return profile;
}

/**
 * Patch professional/bio fields. If a real registration number is supplied,
 * reject a collision with another doctor first (the `PENDING-<id>` placeholder
 * is per-user unique so it never collides).
 */
async function updateProfile(userId, patch) {
  if (patch.registrationNumber !== undefined) {
    const clash = await DoctorProfile.findOne({
      where: { registrationNumber: patch.registrationNumber, userId: { [Op.ne]: userId } },
      attributes: ["userId"],
    });
    if (clash) {
      throw ApiError.conflict("That registration number is already in use", {
        code: ERROR_CODES.REG_NUMBER_IN_USE,
      });
    }
  }
  await DoctorProfile.update(patch, { where: { userId } });
  return getOwnProfile(userId);
}

/** Ensure every id in `ids` exists in `Model`, else 422. */
async function assertAllExist(Model, ids, label) {
  const found = await Model.count({ where: { id: { [Op.in]: ids } } });
  if (found !== new Set(ids).size) {
    throw new ApiError(422, `One or more ${label} are invalid`, {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
}

/**
 * Replace the doctor's specialty set atomically (destroy-all + bulkCreate).
 * Sub-specialties whose parent is no longer in the set are dropped in the same
 * transaction, so a doctor who moves from Orthopaedics to Cardiology never
 * keeps advertising "Spine Surgery".
 */
async function setSpecializations(userId, ids) {
  await assertAllExist(Specialization, ids, "specializations");
  const held = await DoctorSubSpecialization.findAll({
    where: { doctorId: userId },
    attributes: ["subSpecializationId"],
  });
  const orphans = held.length
    ? await SubSpecialization.findAll({
        where: {
          id: { [Op.in]: held.map((r) => r.subSpecializationId) },
          specializationId: { [Op.notIn]: ids },
        },
        attributes: ["id"],
      })
    : [];
  await sequelize.transaction(async (tx) => {
    await DoctorSpecialization.destroy({ where: { doctorId: userId }, transaction: tx });
    await DoctorSpecialization.bulkCreate(
      ids.map((specializationId) => ({ doctorId: userId, specializationId })),
      { transaction: tx }
    );
    if (orphans.length) {
      await DoctorSubSpecialization.destroy({
        where: { doctorId: userId, subSpecializationId: { [Op.in]: orphans.map((o) => o.id) } },
        transaction: tx,
      });
    }
  });
  return getOwnProfile(userId);
}

/**
 * Replace the doctor's sub-specialty set atomically (destroy-all + bulkCreate).
 * Every id must exist AND belong to one of the doctor's saved specialties. An
 * empty list clears the set.
 */
async function setSubSpecializations(userId, ids) {
  if (ids.length) {
    const [rows, specs] = await Promise.all([
      SubSpecialization.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "specializationId"] }),
      DoctorSpecialization.findAll({ where: { doctorId: userId }, attributes: ["specializationId"] }),
    ]);
    if (rows.length !== new Set(ids).size) {
      throw new ApiError(422, "One or more sub-specializations are invalid", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    const allowed = new Set(specs.map((r) => r.specializationId));
    if (rows.some((r) => !allowed.has(r.specializationId))) {
      throw new ApiError(422, "Each sub-specialty must belong to one of your saved specialties", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
  }
  await sequelize.transaction(async (tx) => {
    await DoctorSubSpecialization.destroy({ where: { doctorId: userId }, transaction: tx });
    if (ids.length) {
      await DoctorSubSpecialization.bulkCreate(
        ids.map((subSpecializationId) => ({ doctorId: userId, subSpecializationId })),
        { transaction: tx }
      );
    }
  });
  return getOwnProfile(userId);
}

/** Words kept lowercase mid-label when tidying an all-lowercase entry. */
const LABEL_SMALL_WORDS = new Set(["and", "of", "the", "in", "for", "with", "to", "on"]);

/**
 * Tidy a doctor-typed catalog label. Whitespace is collapsed. If the doctor
 * typed it all lowercase ("spine surgery") it becomes "Spine Surgery"; any
 * deliberate capitals ("IVF", "eCG", "Mohs Surgery") are kept as typed.
 */
function tidyCatalogLabel(raw) {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name !== name.toLowerCase()) return name;
  return name
    .split(" ")
    .map((w, i) => (i > 0 && LABEL_SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Find-or-create a sub-specialty under `specializationId` (doctor "+ Add new").
 * Duplicates are matched case-insensitively on name and on slug (so
 * "spine-surgery" resolves to the existing "Spine Surgery"); the existing row is
 * returned rather than a second one created. Doctors can only ADD — never
 * rename or replace — catalog rows. The new row is shared with every doctor.
 * Returns `{ subSpecialization, created }`.
 */
async function createSubSpecialization({ specializationId, name }) {
  const parent = await Specialization.findByPk(specializationId, { attributes: ["id", "slug"] });
  if (!parent) {
    throw new ApiError(422, "That specialization does not exist", { code: ERROR_CODES.VALIDATION_ERROR });
  }
  const label = tidyCatalogLabel(name);
  const slug = subSpecSlug(parent.slug, label);
  if (slug.length > 150) {
    throw new ApiError(422, "That sub-specialty name is too long", { code: ERROR_CODES.VALIDATION_ERROR });
  }
  const findExisting = () =>
    SubSpecialization.findOne({
      where: {
        specializationId,
        [Op.or]: [{ slug }, sequelize.where(sequelize.fn("LOWER", sequelize.col("name")), label.toLowerCase())],
      },
    });

  const existing = await findExisting();
  if (existing) return { subSpecialization: existing, created: false };

  try {
    const row = await SubSpecialization.create({ name: label, slug, specializationId });
    return { subSpecialization: row, created: true };
  } catch (err) {
    // Another doctor added the same entry a moment ago → hand back theirs.
    if (err instanceof UniqueConstraintError) {
      const raced = await findExisting();
      if (raced) return { subSpecialization: raced, created: false };
      throw ApiError.conflict("That sub-specialty name is already used under another specialty", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    throw err;
  }
}

/** Replace the doctor's language set atomically. */
async function setLanguages(userId, ids) {
  await assertAllExist(Language, ids, "languages");
  await sequelize.transaction(async (tx) => {
    await DoctorLanguage.destroy({ where: { doctorId: userId }, transaction: tx });
    await DoctorLanguage.bulkCreate(
      ids.map((languageId) => ({ doctorId: userId, languageId })),
      { transaction: tx }
    );
  });
  return getOwnProfile(userId);
}

// ── Awards / links / keywords (1:M, ownership scoped by doctorId=userId) ──────
const listAwards = (userId) =>
  DoctorAward.findAll({ where: { doctorId: userId }, order: [["id", "DESC"]] });
const addAward = (userId, data) => DoctorAward.create({ doctorId: userId, ...data });

const listLinks = (userId) =>
  DoctorLink.findAll({ where: { doctorId: userId }, order: [["id", "DESC"]] });
const addLink = (userId, data) => DoctorLink.create({ doctorId: userId, ...data });

const listKeywords = (userId) =>
  DoctorSearchKeyword.findAll({ where: { doctorId: userId }, order: [["id", "DESC"]] });

async function addKeyword(userId, data) {
  const existing = await DoctorSearchKeyword.findOne({
    where: { doctorId: userId, keyword: data.keyword },
    attributes: ["id"],
  });
  if (existing) {
    throw ApiError.conflict("You have already added that keyword");
  }
  return DoctorSearchKeyword.create({ doctorId: userId, ...data });
}

/** Columns on owned rows that point at an uploaded file (award image, testimonial photo). */
const FILE_FIELDS = ["imageUrl", "patientPhotoUrl"];
const fileFieldsOf = (Model) => FILE_FIELDS.filter((f) => f in Model.rawAttributes);

/**
 * Delete one owned child row (award/link/keyword/section); 404 if not the
 * owner's. A file the row pointed at is deleted after the row is gone.
 */
async function removeOwnedRow(Model, userId, id) {
  const fileFields = fileFieldsOf(Model);
  const row = fileFields.length
    ? await Model.findOne({ where: { id, doctorId: userId }, attributes: ["id", ...fileFields] })
    : null;
  const count = await Model.destroy({ where: { id, doctorId: userId } });
  if (!count) throw ApiError.notFound("Item not found");
  for (const f of fileFields) {
    if (row?.[f]) await uploadService.remove(uploadService.keyFromUrl(row[f]));
  }
}

/**
 * Patch one owned row. Ownership is asserted with a read, not via update's
 * affected-row count: MySQL returns rows *changed*, so a no-op patch
 * (identical values) returns 0 and would wrongly 404 an existing, owned row.
 */
async function updateOwnedRow(Model, userId, id, patch) {
  const owned = await Model.findOne({ where: { id, doctorId: userId }, attributes: ["id"] });
  if (!owned) throw ApiError.notFound("Item not found");
  await Model.update(patch, { where: { id, doctorId: userId } });
  return Model.findOne({ where: { id, doctorId: userId } });
}

const updateAward = (userId, id, patch) => updateOwnedRow(DoctorAward, userId, id, patch);
const removeAward = (userId, id) => removeOwnedRow(DoctorAward, userId, id);
const removeLink = (userId, id) => removeOwnedRow(DoctorLink, userId, id);
const removeKeyword = (userId, id) => removeOwnedRow(DoctorSearchKeyword, userId, id);

// ── Portfolio v2: the 6 generic 1:M section resources ─────────────────────────
// One helper set, driven by a key→Model registry, so education/experience/
// services/publications/memberships/faqs share ONE implementation (no 6× copy).
// Ownership is always scoped by doctorId=userId; rows come back ordered.
const OWNED_RESOURCES = Object.freeze({
  education: DoctorEducation,
  experience: DoctorExperience,
  // Also the portfolio's "Procedures" list (no separate procedures table).
  services: DoctorService,
  publications: DoctorPublication,
  memberships: DoctorMembership,
  faqs: DoctorFaq,
  // Doctor-managed patient feedback (migration 048).
  testimonials: DoctorTestimonial,
  // Affiliations / fellowships / expertise (migration 049).
  affiliations: DoctorAffiliation,
  fellowships: DoctorFellowship,
  expertise: DoctorExpertise,
});

/**
 * Sections where the same entry twice is an accidental duplicate: the fields
 * that identify an entry. Matched case-insensitively (the columns use a _ci
 * collation); the validator has already trimmed and collapsed whitespace.
 */
const UNIQUE_BY = Object.freeze({
  services: ["name"],
  expertise: ["category", "name"],
});

const duplicateError = () =>
  ApiError.conflict("You have already added that entry", { code: ERROR_CODES.VALIDATION_ERROR });

/**
 * 409 when another of the doctor's rows already has the same identifying
 * values. On update the identity is the patch merged over the stored row, and
 * the row itself is excluded.
 */
async function assertNotDuplicate(key, userId, data, excludeId = null) {
  const fields = UNIQUE_BY[key];
  if (!fields) return;
  const Model = resolveOwned(key);
  let identity = data;
  if (excludeId != null) {
    if (!fields.some((f) => data[f] !== undefined)) return; // identity untouched
    const current = await Model.findOne({ where: { id: excludeId, doctorId: userId }, attributes: fields });
    if (!current) return; // updateOwnedRow answers the 404
    identity = { ...current.get({ plain: true }), ...data };
  }
  const where = { doctorId: userId };
  for (const f of fields) where[f] = identity[f];
  if (excludeId != null) where.id = { [Op.ne]: excludeId };
  if (await Model.count({ where })) throw duplicateError();
}

/**
 * "Current" means no end year: when a patch marks a role/affiliation current,
 * its end year is cleared in the same write (the validator already rejects a
 * body that sends both).
 */
function normalizeOwned(Model, data) {
  if (data.isCurrent === true && "endYear" in Model.rawAttributes) return { ...data, endYear: null };
  return data;
}

/** Turn the unique-key backstop into the same 409 the pre-check gives. */
const rethrowDuplicate = (err) => {
  if (err instanceof UniqueConstraintError) throw duplicateError();
  throw err;
};

const resolveOwned = (key) => {
  const Model = OWNED_RESOURCES[key];
  if (!Model) throw new ApiError(400, `Unknown portfolio resource: ${key}`);
  return Model;
};

const listOwned = (key, userId) =>
  resolveOwned(key).findAll({
    where: { doctorId: userId },
    order: [
      ["displayOrder", "ASC"],
      ["id", "ASC"],
    ],
  });

async function addOwned(key, userId, data) {
  const Model = resolveOwned(key);
  await assertNotDuplicate(key, userId, data);
  return Model.create({ doctorId: userId, ...normalizeOwned(Model, data) }).catch(rethrowDuplicate);
}

async function updateOwned(key, userId, id, patch) {
  const Model = resolveOwned(key);
  await assertNotDuplicate(key, userId, patch, id);
  return updateOwnedRow(Model, userId, id, normalizeOwned(Model, patch)).catch(rethrowDuplicate);
}

const removeOwned = (key, userId, id) => removeOwnedRow(resolveOwned(key), userId, id);

/**
 * Re-order one of the doctor's lists: `ids` is the FULL list in the new order.
 * Every id must be the doctor's own and none may be missing; one UPDATE sets
 * every display_order. Returns the reordered rows.
 */
async function reorderOwnedRows(Model, userId, ids, label) {
  return sequelize.transaction(async (tx) => {
    const rows = await Model.findAll({
      where: { doctorId: userId },
      attributes: ["id"],
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    const owned = new Set(rows.map((r) => String(r.id)));
    const wanted = ids.map(String);
    if (wanted.length !== owned.size || new Set(wanted).size !== wanted.length || !wanted.every((id) => owned.has(id))) {
      throw new ApiError(422, `Send every one of your ${label} exactly once, in the new order`, {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    if (wanted.length) {
      const cases = wanted.map((id, i) => `WHEN ${sequelize.escape(id)} THEN ${i}`).join(" ");
      await Model.update(
        { displayOrder: sequelize.literal(`CASE id ${cases} END`) },
        { where: { doctorId: userId, id: { [Op.in]: wanted } }, transaction: tx }
      );
    }
    return Model.findAll({
      where: { doctorId: userId },
      order: [
        ["displayOrder", "ASC"],
        ["id", "ASC"],
      ],
      transaction: tx,
    });
  });
}

// ── Gallery (1:M with an uploaded image; mirrors addDocument) ─────────────────
const MAX_GALLERY_IMAGES = 12;

const listGallery = (userId) =>
  DoctorGallery.findAll({
    where: { doctorId: userId },
    order: [
      ["displayOrder", "ASC"],
      ["id", "ASC"],
    ],
  });

/** Gallery metadata columns a doctor may set (migration 049 adds all but caption). */
const GALLERY_META = ["title", "caption", "category", "altText", "takenOn"];

/** Keep only the metadata keys that were sent; a blank value clears the field. */
function galleryMeta(input = {}) {
  const out = {};
  for (const key of GALLERY_META) {
    if (input[key] !== undefined) out[key] = input[key] === "" ? null : input[key];
  }
  return out;
}

/**
 * Store an uploaded gallery picture with its optional metadata. Images only
 * (the shared upload middleware also admits PDFs). New images go to the end of
 * the doctor's arranged order.
 */
async function addGalleryImage(userId, file, meta = {}) {
  assertImageFile(file);
  const [count, last] = await Promise.all([
    DoctorGallery.count({ where: { doctorId: userId } }),
    DoctorGallery.max("displayOrder", { where: { doctorId: userId } }),
  ]);
  if (count >= MAX_GALLERY_IMAGES) {
    throw new ApiError(422, `You can add at most ${MAX_GALLERY_IMAGES} gallery images`, {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  const displayOrder = count ? (Number(last) || 0) + 1 : 0;
  return uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/gallery`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => DoctorGallery.create({ doctorId: userId, imageUrl: url, displayOrder, ...galleryMeta(meta) })
  );
}

/** Edit one gallery picture's metadata (title, caption, category, alt text, date). */
const updateGalleryImage = (userId, id, patch) =>
  updateOwnedRow(DoctorGallery, userId, id, galleryMeta(patch));

/** Re-arrange the gallery: `ids` is every picture's id in the new order. */
const reorderGallery = (userId, ids) => reorderOwnedRows(DoctorGallery, userId, ids, "gallery images");

async function removeGalleryImage(userId, id) {
  const img = await DoctorGallery.findOne({ where: { id, doctorId: userId } });
  if (!img) throw ApiError.notFound("Image not found");
  await img.destroy();
  await uploadService.remove(uploadService.keyFromUrl(img.imageUrl));
}

// ── Insurances (M:N, replace-the-set; mirrors setLanguages) ───────────────────
async function setInsurances(userId, ids) {
  await assertAllExist(Insurance, ids, "insurances");
  await sequelize.transaction(async (tx) => {
    await DoctorInsurance.destroy({ where: { doctorId: userId }, transaction: tx });
    await DoctorInsurance.bulkCreate(
      ids.map((insuranceId) => ({ doctorId: userId, insuranceId })),
      { transaction: tx }
    );
  });
  return getOwnProfile(userId);
}

const listInsurances = () => Insurance.findAll({ order: [["name", "ASC"]] });

// ── Documents ────────────────────────────────────────────────────────────────
const listDocuments = (userId) =>
  DoctorDocument.findAll({ where: { doctorId: userId }, order: [["id", "DESC"]] });

/** Store an uploaded verification document and record the row. */
async function addDocument(userId, docType, file) {
  return uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/docs`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => DoctorDocument.create({ doctorId: userId, docType, fileUrl: url })
  );
}

/** Remove a document (only while not yet approved) — deletes row + stored file. */
async function removeDocument(userId, id) {
  const doc = await DoctorDocument.findOne({ where: { id, doctorId: userId } });
  if (!doc) throw ApiError.notFound("Document not found");

  const profile = await DoctorProfile.findByPk(userId, { attributes: ["verificationStatus"] });
  if (profile?.verificationStatus === "approved") {
    throw ApiError.forbidden("Documents can't be removed after your profile is approved");
  }

  await doc.destroy();
  await uploadService.remove(uploadService.keyFromUrl(doc.fileUrl));
}

/** Upload/replace the profile photo → users.profile_photo_url. Returns the User. */
async function uploadPhoto(userId, file) {
  await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/photo`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => User.update({ profilePhotoUrl: url }, { where: { id: userId } })
  );
  return User.findByPk(userId);
}

// ── Showcase image (the "Why Choose <name>" section picture) ─────────────────
async function uploadShowcaseImage(userId, file) {
  // The shared upload middleware also admits PDFs (documents); this slot is
  // rendered in an <img>, so images only.
  if (!file.mimetype?.startsWith("image/")) {
    throw new ApiError(422, "Unsupported file type — upload a PNG or JPEG image", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  const profile = await DoctorProfile.findByPk(userId);
  if (!profile) throw ApiError.notFound("Doctor profile not found");
  const previous = profile.showcaseImageUrl;
  // The old image goes only after the new URL is committed.
  const url = await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/showcase`, filename: file.originalname, mimetype: file.mimetype },
    async (stored) => {
      await profile.update({ showcaseImageUrl: stored.url });
      return stored.url;
    }
  );
  if (previous && previous !== url) await uploadService.remove(uploadService.keyFromUrl(previous));
  return url;
}

async function removeShowcaseImage(userId) {
  const profile = await DoctorProfile.findByPk(userId);
  if (!profile) throw ApiError.notFound("Doctor profile not found");
  const previous = profile.showcaseImageUrl;
  await profile.update({ showcaseImageUrl: null });
  if (previous) await uploadService.remove(uploadService.keyFromUrl(previous));
}

// ── Pictures on owned rows: award images + testimonial photos (migration 048) ─
/**
 * Store an image and point one owned row's `field` at it. The row must be the
 * doctor's own (404 otherwise, checked before anything is stored); a replaced
 * file is deleted only after the new URL is committed. Returns the fresh row.
 */
async function setOwnedRowImage(Model, field, folder, userId, id, file) {
  assertImageFile(file);
  const row = await Model.findOne({ where: { id, doctorId: userId }, attributes: ["id", field] });
  if (!row) throw ApiError.notFound("Item not found");
  const previous = row[field];
  const url = await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/${folder}`, filename: file.originalname, mimetype: file.mimetype },
    async (stored) => {
      await Model.update({ [field]: stored.url }, { where: { id, doctorId: userId } });
      return stored.url;
    }
  );
  if (previous && previous !== url) await uploadService.remove(uploadService.keyFromUrl(previous));
  return Model.findOne({ where: { id, doctorId: userId } });
}

/** Clear one owned row's picture and delete the file. Returns the fresh row. */
async function clearOwnedRowImage(Model, field, userId, id) {
  const row = await Model.findOne({ where: { id, doctorId: userId }, attributes: ["id", field] });
  if (!row) throw ApiError.notFound("Item not found");
  const previous = row[field];
  if (previous) {
    await Model.update({ [field]: null }, { where: { id, doctorId: userId } });
    await uploadService.remove(uploadService.keyFromUrl(previous));
  }
  return Model.findOne({ where: { id, doctorId: userId } });
}

const uploadAwardImage = (userId, id, file) =>
  setOwnedRowImage(DoctorAward, "imageUrl", "award", userId, id, file);
const removeAwardImage = (userId, id) => clearOwnedRowImage(DoctorAward, "imageUrl", userId, id);

/**
 * The patient's photo on a testimonial. The route's validator requires the
 * doctor to confirm the patient's consent (`consent: true`) before this runs.
 */
const uploadTestimonialPhoto = (userId, id, file) =>
  setOwnedRowImage(DoctorTestimonial, "patientPhotoUrl", "testimonial", userId, id, file);
const removeTestimonialPhoto = (userId, id) =>
  clearOwnedRowImage(DoctorTestimonial, "patientPhotoUrl", userId, id);

/** Re-order the doctor's testimonials: `ids` is the full list in the new order. */
const reorderTestimonials = (userId, ids) => reorderOwnedRows(DoctorTestimonial, userId, ids, "testimonials");

// ── Portfolio hero images (up to three background pictures, migration 046) ───
function assertImageFile(file) {
  // The shared upload middleware also admits PDFs (documents); hero images are
  // rendered in an <img>, so images only.
  if (!file?.mimetype?.startsWith("image/")) {
    throw new ApiError(422, "Unsupported file type — upload a PNG or JPEG image", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
}

const heroLimitError = () =>
  new ApiError(422, `You can upload up to ${MAX_HERO_IMAGES} hero images — remove or replace one first`, {
    code: ERROR_CODES.VALIDATION_ERROR,
  });

/**
 * Add a hero image, or replace the one at `slot` (0-based) when that slot is
 * filled. The list is re-read under a row lock inside the commit, so two
 * uploads racing each other can never push it past three. A replaced file is
 * deleted only after the new URL is committed. Returns the new list.
 */
async function uploadHeroImage(userId, file, slot) {
  assertImageFile(file);
  const profile = await DoctorProfile.findByPk(userId, { attributes: ["userId", "heroImageUrls"] });
  if (!profile) throw ApiError.notFound("Doctor profile not found");
  const current = heroImageList(profile.heroImageUrls);
  const replacing = Number.isInteger(slot) && slot < current.length;
  if (!replacing && current.length >= MAX_HERO_IMAGES) throw heroLimitError();

  let previous = null;
  const urls = await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `doctor/${userId}/hero`, filename: file.originalname, mimetype: file.mimetype },
    (stored) =>
      sequelize.transaction(async (tx) => {
        const fresh = await DoctorProfile.findByPk(userId, {
          attributes: ["userId", "heroImageUrls"],
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        const list = heroImageList(fresh.heroImageUrls);
        if (Number.isInteger(slot) && slot < list.length) {
          previous = list[slot];
          list[slot] = stored.url;
        } else {
          if (list.length >= MAX_HERO_IMAGES) throw heroLimitError();
          list.push(stored.url);
        }
        await fresh.update({ heroImageUrls: list }, { transaction: tx });
        return list;
      })
  );
  if (previous && !urls.includes(previous)) await uploadService.remove(uploadService.keyFromUrl(previous));
  return urls;
}

/** Remove the hero image at `index` (0-based). Returns the new list. */
async function removeHeroImage(userId, index) {
  let removed = null;
  const urls = await sequelize.transaction(async (tx) => {
    const profile = await DoctorProfile.findByPk(userId, {
      attributes: ["userId", "heroImageUrls"],
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!profile) throw ApiError.notFound("Doctor profile not found");
    const list = heroImageList(profile.heroImageUrls);
    if (index >= list.length) throw ApiError.notFound("Hero image not found");
    [removed] = list.splice(index, 1);
    await profile.update({ heroImageUrls: list.length ? list : null }, { transaction: tx });
    return list;
  });
  if (removed) await uploadService.remove(uploadService.keyFromUrl(removed));
  return urls;
}

module.exports = {
  fullInclude,
  cardInclude,
  publicListingWhere,
  publicListingSql,
  isPubliclyListed,
  PUBLIC_LISTING_ATTRIBUTES,
  getOwnProfile,
  updateProfile,
  setSpecializations,
  setSubSpecializations,
  createSubSpecialization,
  setLanguages,
  listAwards,
  addAward,
  updateAward,
  removeAward,
  uploadAwardImage,
  removeAwardImage,
  uploadTestimonialPhoto,
  removeTestimonialPhoto,
  reorderTestimonials,
  listLinks,
  addLink,
  removeLink,
  listKeywords,
  addKeyword,
  removeKeyword,
  listDocuments,
  addDocument,
  removeDocument,
  uploadPhoto,
  uploadShowcaseImage,
  removeShowcaseImage,
  uploadHeroImage,
  removeHeroImage,
  // Portfolio v2
  listOwned,
  addOwned,
  updateOwned,
  removeOwned,
  listGallery,
  addGalleryImage,
  updateGalleryImage,
  reorderGallery,
  removeGalleryImage,
  setInsurances,
  listInsurances,
};
