/**
 * Patient profile business logic (docs/booking-payments Phase 0).
 *
 * The `patient_profiles` row already exists from signup (user.service
 * .createProfileRow), so this service only ever READS or UPDATES it — never
 * creates it. It also owns the "profile complete enough to book?" gate: the
 * booking service calls `assertProfileComplete` before holding a slot, because
 * a doctor can't review a case with no patient data (PRD §4.5).
 *
 * The shared user fields (phone) and the patient_profiles row are updated
 * together atomically, mirroring auth.service.updateProfile.
 */
const {
  sequelize,
  User,
  PatientProfile,
  Allergy,
  Condition,
  PatientAllergy,
  PatientCondition,
  PatientCurrentMedication,
  UploadedRecord,
} = require("../models");
const ApiError = require("../utils/ApiError");
const {
  ROLES,
  ERROR_CODES,
  PATIENT_REQUIRED_FIELDS,
  RECORD_SOURCES,
  DOCUMENT_KIND_FILE_TYPE,
  IDENTITY_FILE_TYPE,
} = require("../config/constants");
const userService = require("./user.service");
const uploadService = require("./upload.service");
// The one booking-scoped access gate every doctor→patient read/write shares.
const { gateBookingPatient } = require("./patientVitals.service");

/** Load the patient's user row + profile in ONE query. */
function getUserWithProfile(userId) {
  return userService.findWithProfile(userId, ROLES.PATIENT);
}

/**
 * Flatten the required-field values from their two homes (users + profile) so
 * the completeness check reads one map. `city` etc. live on the profile row;
 * `phone` on the user row.
 */
function requiredFieldValues(user) {
  const profile = user.patientProfile || {};
  return {
    phone: user.phone,
    dateOfBirth: profile.dateOfBirth,
    gender: profile.gender,
    city: profile.city,
  };
}

const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * @returns {{ complete: boolean, missing: string[] }} — which required fields
 * are still empty. Both the API response and the booking gate read this.
 */
function computeProfileStatus(user) {
  const values = requiredFieldValues(user);
  const missing = PATIENT_REQUIRED_FIELDS.filter((f) => isBlank(values[f]));
  return { complete: missing.length === 0, missing };
}

/** The patient's own profile (user + profile row) — for GET /patient/profile. */
async function getProfile(userId) {
  const user = await getUserWithProfile(userId);
  if (!user) throw ApiError.notFound("User not found");
  return user;
}

/**
 * Update the patient's own profile. `phone` (a user column) and the
 * patient_profiles fields are whitelisted and written together atomically. The
 * validator has already coerced/shaped the body; here we only route each field
 * to its table.
 */
async function updateProfile(userId, patch) {
  const userFields = {};
  if (patch.phone !== undefined) userFields.phone = patch.phone;
  if (patch.name !== undefined) userFields.name = patch.name;

  const profileFields = {};
  for (const key of [
    "dateOfBirth",
    "gender",
    "bloodGroup",
    "emergencyContactName",
    "emergencyContactPhone",
    "addressLine",
    "city",
    "state",
    "pincode",
    "noKnownAllergies",
    "noKnownConditions",
  ]) {
    if (patch[key] !== undefined) profileFields[key] = patch[key];
  }

  await sequelize.transaction(async (tx) => {
    if (Object.keys(userFields).length) {
      await User.update(userFields, { where: { id: userId }, transaction: tx });
    }
    if (Object.keys(profileFields).length) {
      await PatientProfile.update(profileFields, { where: { userId }, transaction: tx });
    }
  });

  return getProfile(userId);
}

/**
 * The booking gate. Throws 409 PROFILE_INCOMPLETE (listing the missing fields)
 * if the patient hasn't filled the required set — called by booking.service
 * .create before any slot is held.
 */
async function assertProfileComplete(userId) {
  const user = await getUserWithProfile(userId);
  if (!user) throw ApiError.notFound("User not found");
  const status = computeProfileStatus(user);
  if (!status.complete) {
    throw ApiError.conflict("Complete your profile before booking", {
      code: ERROR_CODES.PROFILE_INCOMPLETE,
      details: { missing: status.missing },
    });
  }
}

/**
 * The dashboard completion bar's data. A WEIGHTED superset of the boolean
 * booking gate (`computeProfileStatus`) — never blocks booking, purely
 * informational. `percent` = Σ (done ? weight). Reads live counts of the
 * sub-resources so "added ≥1 vital / allergy" can count, with the "no known"
 * acknowledgements letting a genuinely-clear patient still reach 100%.
 */
async function computeProfileCompletion(user) {
  const profile = user.patientProfile || {};

  // WHO THE PATIENT IS — nothing else.
  //
  // Blood group, allergies, conditions and vitals used to score here too, which
  // made "Complete your profile" a permanent 70%: they are a health RECORD, not
  // identity, they grow over a lifetime, and there is no state in which they are
  // "finished". They live on the Records page now and are deliberately not
  // measured — a patient with no allergies is not an incomplete patient.
  //
  // Weights re-based to 100 across the three remaining sections, so a patient
  // who had already filled these in still reads 100% instead of dropping to 60.
  const sections = [
    {
      key: "identity",
      label: "Basic details",
      done:
        !isBlank(user.phone) &&
        !isBlank(profile.dateOfBirth) &&
        !isBlank(profile.gender) &&
        !isBlank(profile.city),
      weight: 60,
    },
    {
      key: "address",
      label: "Address",
      done: !isBlank(profile.addressLine) && !isBlank(profile.state) && !isBlank(profile.pincode),
      weight: 20,
    },
    {
      key: "emergency",
      label: "Emergency contact",
      done: !isBlank(profile.emergencyContactName) && !isBlank(profile.emergencyContactPhone),
      weight: 20,
    },
  ];
  const percent = sections.reduce((sum, s) => sum + (s.done ? s.weight : 0), 0);
  return { percent, sections, missingRequired: computeProfileStatus(user).missing };
}

/**
 * The clinical snapshot of a patient, for a CLINIC that has already been
 * authorised by the route (approved clinic + `resolveClinicPatient`).
 *
 * Returns the exact same shape the doctor sees in a consultation, and is fed to
 * the SAME `serializePatientSnapshot` — which omits `email` — so a clinic can
 * never see a richer version of a patient than a treating doctor can.
 *
 * Everything is eager-loaded in one query; no query-in-a-loop.
 */
async function getSnapshotForClinic(patientId) {
  const user = await User.findByPk(patientId, {
    attributes: ["id", "name", "phone", "profilePhotoUrl"],
    include: [
      {
        model: PatientProfile,
        as: "patientProfile",
        include: [
          { model: Allergy, as: "allergies", through: { attributes: ["severity"] } },
          { model: Condition, as: "conditions", through: { attributes: ["diagnosedYear"] } },
          { model: PatientCurrentMedication, as: "medications" },
        ],
      },
      // Clinic view: identity documents are the patient's own. required:false
      // keeps the LEFT JOIN — a patient with no documents must still load.
      { model: UploadedRecord.scope("clinical"), as: "uploadedRecords", required: false },
    ],
  });
  if (!user) throw ApiError.notFound("Patient not found");
  return user;
}

// ── Health-record sub-resources ──────────────────────────────────────────────

/**
 * Resolve a set of lookup names → ids in a bounded number of queries (never one
 * per name): read the existing rows, bulk-create the missing ones, re-read those.
 * Shared by the allergies/conditions replace-set writes.
 */
async function resolveLookupIds(Model, names, tx) {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const map = new Map();
  if (!clean.length) return map;
  const existing = await Model.findAll({ where: { name: clean }, transaction: tx });
  for (const r of existing) map.set(r.name, r.id);
  const missing = clean.filter((n) => !map.has(n));
  if (missing.length) {
    await Model.bulkCreate(missing.map((name) => ({ name })), { transaction: tx, ignoreDuplicates: true });
    const created = await Model.findAll({ where: { name: missing }, transaction: tx });
    for (const r of created) map.set(r.name, r.id);
  }
  return map;
}

/** The patient's allergies (junction rows with the joined lookup name). */
function getAllergies(userId) {
  return PatientAllergy.findAll({
    where: { patientId: userId },
    include: [
      { model: Allergy, as: "allergy" },
      // LEFT JOIN for the source chip's name — must stay LEFT: the author FK is
      // ON DELETE SET NULL, and a row whose author was deleted still counts.
      { model: User, as: "recordedBy", attributes: ["id", "name", "role"] },
    ],
    order: [[{ model: Allergy, as: "allergy" }, "name", "ASC"]],
  });
}

/**
 * Replace the patient's whole allergy set (+ the "no known" flag).
 *
 * The patient MAY delete a clinic-recorded row — that is the product decision.
 * But merely SAVING this form must not silently rewrite who recorded the rows
 * they kept: this is a destroy-and-recreate, so without carrying the original
 * provenance forward, every clinic-added allergy would come back stamped
 * "patient" and the source chip would quietly lie. So the existing rows' source
 * is read first and re-applied to any row that survives the save.
 */
async function setAllergies(userId, { items = [], noKnown }) {
  await sequelize.transaction(async (tx) => {
    const map = await resolveLookupIds(Allergy, items.map((i) => i.name), tx);

    const existing = await PatientAllergy.findAll({
      where: { patientId: userId },
      attributes: ["allergyId", "source", "recordedByUserId"],
      transaction: tx,
    });
    const priorById = new Map(existing.map((r) => [r.allergyId, r]));

    const seen = new Set();
    const rows = [];
    for (const it of items) {
      const id = map.get(it.name.trim());
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const prior = priorById.get(id);
      rows.push({
        patientId: userId,
        allergyId: id,
        severity: it.severity || null,
        // Kept row → its original author. New row → the patient, who is saving.
        source: prior ? prior.source : RECORD_SOURCES.PATIENT,
        recordedByUserId: prior ? prior.recordedByUserId : userId,
      });
    }
    await PatientAllergy.destroy({ where: { patientId: userId }, transaction: tx });
    if (rows.length) await PatientAllergy.bulkCreate(rows, { transaction: tx });
    if (noKnown !== undefined) {
      await PatientProfile.update({ noKnownAllergies: !!noKnown }, { where: { userId }, transaction: tx });
    }
  });
  return getAllergies(userId);
}

/**
 * ADD allergies for a patient without touching what is already there — the
 * clinic write path.
 *
 * POST semantics, never PUT: `setAllergies` above deletes the whole set first,
 * which is correct for the patient's own form (it submits every row it is
 * showing) and catastrophic for a clinic (which is showing none of them and
 * would silently wipe the patient's history).
 *
 * `patient_allergies` has a composite PK (patient_id, allergy_id), so a name the
 * patient already has is a PK collision rather than a duplicate row —
 * `ignoreDuplicates` makes re-adding it a no-op and leaves the ORIGINAL row's
 * source and severity intact.
 */
async function addAllergiesFor(patientId, { items = [] }, author) {
  await sequelize.transaction(async (tx) => {
    const map = await resolveLookupIds(Allergy, items.map((i) => i.name), tx);
    const seen = new Set();
    const rows = [];
    for (const it of items) {
      const id = map.get(it.name.trim());
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        patientId,
        allergyId: id,
        severity: it.severity || null,
        source: author.source,
        recordedByUserId: author.userId,
      });
    }
    if (rows.length) {
      await PatientAllergy.bulkCreate(rows, { transaction: tx, ignoreDuplicates: true });
      // Recording an allergy contradicts "no known allergies" — clear the flag
      // in the same transaction so the patient's own page can't show both.
      await PatientProfile.update(
        { noKnownAllergies: false },
        { where: { userId: patientId }, transaction: tx }
      );
    }
  });
  return getAllergies(patientId);
}

/** The patient's chronic conditions (junction rows with the joined lookup name). */
function getConditions(userId) {
  return PatientCondition.findAll({
    where: { patientId: userId },
    include: [
      { model: Condition, as: "condition" },
      { model: User, as: "recordedBy", attributes: ["id", "name", "role"] },
    ],
    order: [[{ model: Condition, as: "condition" }, "name", "ASC"]],
  });
}

/** Replace the patient's whole condition set — provenance preserved, see setAllergies. */
async function setConditions(userId, { items = [], noKnown }) {
  await sequelize.transaction(async (tx) => {
    const map = await resolveLookupIds(Condition, items.map((i) => i.name), tx);

    const existing = await PatientCondition.findAll({
      where: { patientId: userId },
      attributes: ["conditionId", "source", "recordedByUserId"],
      transaction: tx,
    });
    const priorById = new Map(existing.map((r) => [r.conditionId, r]));

    const seen = new Set();
    const rows = [];
    for (const it of items) {
      const id = map.get(it.name.trim());
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const prior = priorById.get(id);
      rows.push({
        patientId: userId,
        conditionId: id,
        diagnosedYear: it.diagnosedYear ?? null,
        source: prior ? prior.source : RECORD_SOURCES.PATIENT,
        recordedByUserId: prior ? prior.recordedByUserId : userId,
      });
    }
    await PatientCondition.destroy({ where: { patientId: userId }, transaction: tx });
    if (rows.length) await PatientCondition.bulkCreate(rows, { transaction: tx });
    if (noKnown !== undefined) {
      await PatientProfile.update({ noKnownConditions: !!noKnown }, { where: { userId }, transaction: tx });
    }
  });
  return getConditions(userId);
}

/** ADD conditions without replacing the set — see addAllergiesFor. */
async function addConditionsFor(patientId, { items = [] }, author) {
  await sequelize.transaction(async (tx) => {
    const map = await resolveLookupIds(Condition, items.map((i) => i.name), tx);
    const seen = new Set();
    const rows = [];
    for (const it of items) {
      const id = map.get(it.name.trim());
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        patientId,
        conditionId: id,
        diagnosedYear: it.diagnosedYear ?? null,
        source: author.source,
        recordedByUserId: author.userId,
      });
    }
    if (rows.length) {
      await PatientCondition.bulkCreate(rows, { transaction: tx, ignoreDuplicates: true });
      await PatientProfile.update(
        { noKnownConditions: false },
        { where: { userId: patientId }, transaction: tx }
      );
    }
  });
  return getConditions(patientId);
}

/** Whitelist the medication columns a write may touch (coerce "" → null). */
function pickMedication(body) {
  const out = {};
  for (const k of ["medicineName", "dosage", "frequency", "startedOn", "notes"]) {
    if (body[k] !== undefined) out[k] = body[k] === "" ? null : body[k];
  }
  return out;
}

function getMedications(userId) {
  return PatientCurrentMedication.findAll({ where: { patientId: userId }, order: [["id", "DESC"]] });
}

function addMedication(userId, body) {
  return sequelize.transaction(async (tx) => {
    const row = await PatientCurrentMedication.create(
      { patientId: userId, ...pickMedication(body) },
      { transaction: tx },
    );
    // Adding a medicine contradicts "no current medications", so the answer is
    // withdrawn in the same transaction — the profile must never assert both.
    await PatientProfile.update(
      { noCurrentMedications: false },
      { where: { userId }, transaction: tx },
    );
    return row;
  });
}

/**
 * Record (or withdraw) the "I take nothing" answer.
 *
 * Checking it CLEARS the medication list, mirroring `setAllergies`: the two
 * states are mutually exclusive, and leaving rows behind would let the profile
 * claim "no current medications" while still listing some. Unchecking only
 * clears the flag — it cannot bring deleted rows back, which is why the UI
 * confirms before wiping a non-empty list.
 */
async function setNoCurrentMedications(userId, noCurrent) {
  await sequelize.transaction(async (tx) => {
    if (noCurrent) {
      await PatientCurrentMedication.destroy({ where: { patientId: userId }, transaction: tx });
    }
    await PatientProfile.update(
      { noCurrentMedications: !!noCurrent },
      { where: { userId }, transaction: tx },
    );
  });
  return getMedications(userId);
}

async function updateMedication(userId, id, body) {
  const row = await PatientCurrentMedication.findOne({ where: { id, patientId: userId } });
  if (!row) throw ApiError.notFound("Medication not found");
  await row.update(pickMedication(body));
  return row;
}

async function deleteMedication(userId, id) {
  const n = await PatientCurrentMedication.destroy({ where: { id, patientId: userId } });
  if (!n) throw ApiError.notFound("Medication not found");
}

/**
 * Who is writing this record. Defaults to the patient themselves, so every
 * existing call site keeps its exact previous behaviour; the clinic write path
 * passes its own identity and the row is stamped `source:'clinic'`.
 */
const selfAuthor = (userId) => ({ source: RECORD_SOURCES.PATIENT, userId });

/**
 * The patient's own rows INCLUDING identity documents. Every other reader
 * (doctors, clinics, labs, admins) leaves those out — see getRecords and
 * clinicalAccess.recordAllowed.
 */
const ownRecords = () => UploadedRecord;
const RECORDED_BY = { model: User, as: "recordedBy", attributes: ["id", "name", "role"] };

/**
 * The patient's documents. `includeIdentity` is set ONLY by the patient's own
 * GET /patient/records — the clinic and admin portals reuse this function and
 * must never receive an Aadhaar or insurance card.
 */
function getRecords(userId, { includeIdentity = false } = {}) {
  return (includeIdentity ? ownRecords() : UploadedRecord.scope("clinical")).findAll({
    where: { patientId: userId },
    // Eager-loaded so the source chip can show WHO uploaded it. LEFT JOIN by
    // default, which matters: recorded_by_user_id is ON DELETE SET NULL, so a
    // record whose author was deleted must still be listed.
    include: [RECORDED_BY],
    order: [
      ["uploadedAt", "DESC"],
      ["id", "DESC"],
    ],
  });
}

/** What a full Aadhaar (or any 12-digit ID) looks like, spaced or not. */
const FULL_ID_NUMBER = /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/;
const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The descriptive columns of a create/edit body, normalised.
 *
 * The file_type FOLLOWS the document kind when one is given: file_type decides
 * which doctor-consent category protects a document, so it is the server's
 * call, never the client's. `current` is the row being edited (null on create)
 * so the final type — and with it the identity rules — can be worked out.
 */
function pickRecordMeta(body, current = null) {
  const out = {};
  if (body.documentKind !== undefined) {
    out.documentKind = body.documentKind || null;
    if (out.documentKind) out.fileType = DOCUMENT_KIND_FILE_TYPE[out.documentKind];
  }
  if (out.fileType === undefined && body.fileType !== undefined) out.fileType = body.fileType;
  // A legacy edit that only moves the type must not leave a kind that now
  // contradicts it (a "CT scan" filed as a prescription).
  if (
    out.documentKind === undefined &&
    out.fileType &&
    current?.documentKind &&
    DOCUMENT_KIND_FILE_TYPE[current.documentKind] !== out.fileType
  ) {
    out.documentKind = null;
  }
  if (body.recordDate !== undefined) out.recordDate = body.recordDate || null;
  if (body.tag !== undefined) out.tag = textOrNull(body.tag);
  if (body.location !== undefined) out.location = textOrNull(body.location);
  if (body.doctorName !== undefined) out.doctorName = textOrNull(body.doctorName);
  if (body.description !== undefined) out.description = textOrNull(body.description);
  if (body.idLast4 !== undefined) out.idLast4 = textOrNull(body.idLast4);

  const finalType = out.fileType ?? current?.fileType ?? "prescription";
  if (finalType === IDENTITY_FILE_TYPE) {
    // Only the last four digits are ever kept. A full number typed into the
    // title or notes would defeat that, so it is refused rather than stored.
    const tag = out.tag !== undefined ? out.tag : current?.tag;
    const description = out.description !== undefined ? out.description : current?.description;
    if ([tag, description].some((t) => t && FULL_ID_NUMBER.test(t))) {
      throw new ApiError(422, "Don't type a full Aadhaar or ID number — enter only its last 4 digits", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
  } else if (out.idLast4 !== undefined || current?.idLast4) {
    out.idLast4 = null; // last-4 digits belong to identity documents only
  }
  return out;
}

/** The uploaded file's own name, for display only — never used as a storage key. */
const displayName = (name) =>
  String(name || "")
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 255) || null;

/** File facts stored beside the link (migration 058). */
const fileFacts = (file) => ({
  originalName: displayName(file.originalname),
  mimeType: String(file.mimetype || "").slice(0, 120) || null,
  fileSize: Number.isFinite(file.size) ? file.size : (file.buffer?.length ?? null),
});

/** Identity documents are the patient's own — nobody else may file one for them. */
function assertMayFile(meta, author) {
  if (meta.fileType === IDENTITY_FILE_TYPE && author.source !== RECORD_SOURCES.PATIENT) {
    throw ApiError.forbidden("Only the patient can add identity documents");
  }
}

function addRecord(userId, body, author = selfAuthor(userId)) {
  const meta = pickRecordMeta(body);
  assertMayFile(meta, author);
  return UploadedRecord.create({
    patientId: userId,
    fileUrl: body.fileUrl,
    fileType: "prescription",
    ...meta,
    source: author.source,
    recordedByUserId: author.userId,
  });
}

/**
 * True when a storage key is one THIS patient's record upload created — the
 * prefixes `uploadRecord` writes (self, clinic- or admin-authored). A pasted
 * link that merely points into our storage (someone else's photo, a doctor's
 * document) is never ours to delete.
 */
function isOwnRecordKey(patientId, key) {
  if (!key) return false;
  const id = String(patientId);
  return key.startsWith(`patient/${id}/records/`) || new RegExp(`^(clinic|admin)/[^/]+/patients/${id}/`).test(key);
}

/** Multipart variant of addRecord: store the file, then create the row. */
async function uploadRecord(userId, file, body, author = selfAuthor(userId)) {
  const meta = pickRecordMeta(body);
  assertMayFile(meta, author);
  // Key prefix follows the AUTHOR, not the patient, so a clinic's or admin's
  // uploads are grouped under the author in storage and are trivially auditable.
  const keyPrefix =
    author.source === RECORD_SOURCES.CLINIC
      ? `clinic/${author.userId}/patients/${userId}`
      : author.source === RECORD_SOURCES.ADMIN
        ? `admin/${author.userId}/patients/${userId}`
        : `patient/${userId}/records`;
  return uploadService.storeThen(
    file.buffer,
    { keyPrefix, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) =>
      UploadedRecord.create({
        patientId: userId,
        fileUrl: url,
        fileType: "prescription",
        ...meta,
        ...fileFacts(file),
        source: author.source,
        recordedByUserId: author.userId,
      })
  );
}

/**
 * One of the patient's OWN uploads (identity included), else 404 / 403. The
 * source check keeps them out of rows a clinic, doctor or lab authored — the
 * point of migration 018: the UI chips such a row as not-yours, so letting the
 * patient silently rewrite or erase it would make that badge a lie.
 */
async function findOwnUpload(userId, id, action) {
  // Same include as getRecords: the serializer emits the author for the
  // source chip, so a PATCH response must carry it.
  const row = await ownRecords().findOne({ where: { id, patientId: userId }, include: [RECORDED_BY] });
  if (!row) throw ApiError.notFound("Record not found");
  if (row.source !== RECORD_SOURCES.PATIENT) {
    throw ApiError.forbidden(`Only documents you uploaded yourself can be ${action}`);
  }
  return row;
}

/** Edit a record's descriptive fields (the file is replaced separately). */
async function updateRecord(userId, id, body) {
  const row = await findOwnUpload(userId, id, "edited");
  await row.update({ ...pickRecordMeta(body, row), updatedAt: new Date() });
  return row;
}

/**
 * Swap the file behind one of the patient's own documents, keeping its
 * details. The new file is stored and the row repointed in one step
 * (storeThen discards the new file if that fails); only then is the old file
 * removed, so a failure never leaves the row pointing at nothing.
 */
async function replaceRecordFile(userId, id, file) {
  const row = await findOwnUpload(userId, id, "replaced");
  const oldKey = uploadService.keyFromUrl(row.fileUrl);
  await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `patient/${userId}/records`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => row.update({ fileUrl: url, ...fileFacts(file), updatedAt: new Date() })
  );
  if (isOwnRecordKey(userId, oldKey)) {
    try {
      await uploadService.remove(oldKey);
    } catch (err) {
      console.error(`⚠️  Replaced record ${row.id} but could not remove its old file:`, err.message);
    }
  }
  return row;
}

/**
 * Remove one of the patient's own uploads. Documents a doctor, clinic or lab
 * filed (a signed prescription's copy, a lab report) stay: they are clinical
 * records the patient did not author, so they are not the patient's to erase.
 */
async function deleteRecord(userId, id) {
  const rec = await findOwnUpload(userId, id, "removed");
  await rec.destroy();
  // Unlink the stored file only when we stored it for THIS patient — pasted
  // links (even ones pointing into our storage) are never ours to delete.
  const key = uploadService.keyFromUrl(rec.fileUrl);
  if (isOwnRecordKey(userId, key)) {
    await uploadService.remove(key);
  }
}

/**
 * A doctor correcting the DATE a document speaks for, reached through one of
 * their OWN bookings — same unlock gate as vitals/clinical notes, so an unpaid
 * hold grants nothing. Date only: the file, its type and its label stay the
 * uploader's. The patient-side `updateRecord` source guard deliberately does
 * NOT apply here — the whole point is a clinician fixing a date the uploader
 * got wrong, whoever the uploader was.
 */
async function updateRecordDateForDoctor(doctorId, bookingId, recordId, recordDate) {
  const booking = await gateBookingPatient(doctorId, bookingId);
  const row = await UploadedRecord.findOne({
    where: { id: recordId, patientId: booking.patientId },
    include: [{ model: User, as: "recordedBy", attributes: ["id", "name", "role"] }],
  });
  if (!row) throw ApiError.notFound("Record not found");
  // Same consent rule as every other doctor read of a document: the doctor's
  // own upload, or its category granted by the patient. A locked document is
  // "not found" — never edited, never returned with a file link.
  const access = require("./clinicalAccess.service");
  const scope = await access.scopeFor(doctorId, booking.patientId);
  if (!access.recordAllowed(scope, row)) throw ApiError.notFound("Record not found");
  await row.update({ recordDate });
  return row;
}

/** Upload/replace the profile photo → users.profile_photo_url. Returns the User. */
async function uploadPhoto(userId, file) {
  // The shared upload middleware also admits PDFs (documents); this slot is
  // rendered in an <img>, so images only — mirrors the doctor photo upload.
  if (!file.mimetype?.startsWith("image/")) {
    throw new ApiError(422, "Unsupported file type — upload a PNG or JPEG image", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `patient/${userId}/photo`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => User.update({ profilePhotoUrl: url }, { where: { id: userId } })
  );
  return User.findByPk(userId);
}

module.exports = {
  getProfile,
  updateProfile,
  computeProfileStatus,
  computeProfileCompletion,
  getSnapshotForClinic,
  assertProfileComplete,
  getAllergies,
  setAllergies,
  addAllergiesFor,
  getConditions,
  setConditions,
  addConditionsFor,
  getMedications,
  addMedication,
  updateMedication,
  deleteMedication,
  setNoCurrentMedications,
  getRecords,
  addRecord,
  uploadRecord,
  updateRecord,
  replaceRecordFile,
  updateRecordDateForDoctor,
  deleteRecord,
  uploadPhoto,
};
