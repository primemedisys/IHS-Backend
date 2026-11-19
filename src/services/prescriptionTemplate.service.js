/**
 * Letterhead template business logic (docs/prescriptions/backend-plan.md §4.2).
 *
 * Ownership is always a WHERE clause, never a preceding SELECT + `if` — a row
 * that isn't the caller's simply doesn't exist (404, not 403, so we never
 * confirm that someone else's template id is real).
 *
 * `resolveTemplate` is the reason a doctor who has configured nothing can still
 * write their first prescription: it falls back to auto-provisioning a
 * letterhead seeded from their own profile and clinic.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  PrescriptionTemplate,
  Clinic,
  DoctorProfile,
  User,
} = require("../models");
const ApiError = require("../utils/ApiError");
const upload = require("./upload.service");
const pdfService = require("./prescriptionPdf.service");
const { ERROR_CODES, TEMPLATE_ASSET_MIME } = require("../config/constants");

const ASSET_COLUMN = { logo: "logoUrl", watermark: "watermarkUrl", signature: "signatureUrl" };

/** `kind` arrives from a URL param on DELETE — never index a column name with it unchecked. */
function assetColumn(kind) {
  const column = ASSET_COLUMN[kind];
  if (!column) {
    throw new ApiError(422, "Unknown asset — expected logo, watermark or signature", {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  return column;
}

const withClinic = [{ model: Clinic, as: "clinic", attributes: ["id", "name"] }];

/** Fetch one owned, active-or-not template or 404. */
async function findOwned(doctorId, id, options = {}) {
  const row = await PrescriptionTemplate.findOne({
    where: { id, doctorId },
    include: withClinic,
    ...options,
  });
  if (!row) {
    throw new ApiError(404, "Template not found", { code: ERROR_CODES.TEMPLATE_NOT_FOUND });
  }
  return row;
}

exports.list = (doctorId) =>
  PrescriptionTemplate.findAll({
    where: { doctorId, isActive: true },
    include: withClinic,
    order: [
      ["isDefault", "DESC"],
      ["updatedAt", "DESC"],
    ],
  });

exports.getOne = (doctorId, id) => findOwned(doctorId, id);

/**
 * Seed a complete, usable letterhead from what the doctor already told us
 * during onboarding. Not a nicety: without it the first prescription a doctor
 * ever writes is blocked behind a design task.
 */
async function buildDefaultTemplate(doctorId, clinic) {
  const profile = await DoctorProfile.findByPk(doctorId, {
    attributes: ["userId", "qualification", "registrationNumber", "headline", "publicPhone", "publicEmail"],
    include: [{ model: User, as: "user", attributes: ["name", "email", "phone"] }],
  });
  if (!profile) throw new ApiError(404, "Doctor not found", { code: ERROR_CODES.NOT_FOUND });

  const name = profile.user?.name ?? "Doctor";
  const regNo = profile.registrationNumber ?? "";
  const credentialLines = [profile.qualification, profile.headline].filter(Boolean);

  const contactLines = [profile.publicPhone || profile.user?.phone, clinic?.phone].filter(Boolean);
  const webLines = [profile.publicEmail || profile.user?.email].filter(Boolean);
  const addressLines = clinic
    ? [clinic.addressLine, [clinic.city, clinic.pincode].filter(Boolean).join(", ")].filter(Boolean)
    : [];

  const footerColumns = [
    addressLines.length && { title: "Address:", lines: addressLines },
    contactLines.length && { title: "Contact:", lines: contactLines },
    webLines.length && { title: "Web:", lines: webLines },
  ].filter(Boolean);

  return {
    doctorId,
    clinicId: clinic?.id ?? null,
    name: clinic ? `${clinic.name} letterhead` : "Default letterhead",
    isDefault: false, // the caller decides; create() promotes the first one
    headerJson: {
      doctorNameLine: `DR. ${name.toUpperCase()}`,
      credentialLines,
      clinicName: clinic?.name ?? "",
      clinicTagline: clinic ? [clinic.addressLine, clinic.city].filter(Boolean).join(", ") : "",
      regNoLabel: "Regd. No.",
      regNoValue: regNo.startsWith("PENDING-") ? "" : regNo,
      logoPosition: "right",
    },
    patientFieldsJson: [
      { key: "name", label: "Name", enabled: true, row: 1 },
      { key: "age", label: "Age/Sex", enabled: true, row: 1 },
      { key: "phone", label: "Phone", enabled: true, row: 1 },
      { key: "address", label: "Address", enabled: true, row: 2 },
      { key: "bp", label: "BP", enabled: true, row: 2 },
      { key: "pulse", label: "Pulse", enabled: true, row: 2 },
      { key: "weight", label: "Wt", enabled: true, row: 2 },
      { key: "height", label: "Ht", enabled: true, row: 2 },
      { key: "temperature", label: "Temp", enabled: true, row: 2 },
      { key: "spo2", label: "SpO2", enabled: false, row: 2 },
    ],
    sidebarJson: { title: "Advice", groups: [{ title: "", items: [] }] },
    bodyJson: {
      rxSymbol: true,
      showDiagnosis: true,
      showVitals: true,
      medicineColumns: ["medicineName", "dosage", "frequency", "timing", "durationDays"],
      showAdviceText: true,
      showFollowUp: true,
      disclaimer: "",
    },
    footerJson: {
      columns: footerColumns.length ? footerColumns : [{ title: "Contact:", lines: [] }],
    },
  };
}
exports.buildDefaultTemplate = buildDefaultTemplate;

/** Verify a clinicId (when given) belongs to this doctor. */
async function assertOwnedClinic(doctorId, clinicId) {
  if (clinicId == null) return null;
  const clinic = await Clinic.findOne({ where: { id: clinicId, doctorId } });
  if (!clinic) throw new ApiError(404, "Clinic not found", { code: ERROR_CODES.NOT_FOUND });
  return clinic;
}

exports.create = async (doctorId, dto) => {
  const clinic = await assertOwnedClinic(doctorId, dto.clinicId);
  const defaults = await buildDefaultTemplate(doctorId, clinic);

  // A doctor's very first template is necessarily the default.
  const existing = await PrescriptionTemplate.count({ where: { doctorId, isActive: true } });

  return PrescriptionTemplate.create({
    ...defaults,
    ...dto,
    doctorId,
    clinicId: dto.clinicId ?? null,
    isDefault: existing === 0,
  });
};

exports.update = async (doctorId, id, dto) => {
  const row = await findOwned(doctorId, id);
  if (dto.clinicId !== undefined) await assertOwnedClinic(doctorId, dto.clinicId);

  // JSON blobs are replaced wholesale — the editor always holds the whole blob,
  // and array-patch semantics would be a bug factory. Scalars patch normally.
  await row.update(dto);
  return findOwned(doctorId, id);
};

/**
 * Exactly one default per doctor. The clear-then-set pair must be atomic, or a
 * crash between them leaves the doctor with no default at all.
 */
exports.setDefault = async (doctorId, id) => {
  await sequelize.transaction(async (t) => {
    await PrescriptionTemplate.update(
      { isDefault: false },
      { where: { doctorId, isDefault: true }, transaction: t }
    );
    const [n] = await PrescriptionTemplate.update(
      { isDefault: true },
      { where: { id, doctorId, isActive: true }, transaction: t }
    );
    if (!n) {
      throw new ApiError(404, "Template not found", { code: ERROR_CODES.TEMPLATE_NOT_FOUND });
    }
  });
  return findOwned(doctorId, id);
};

exports.duplicate = async (doctorId, id, { name, clinicId }) => {
  const src = await findOwned(doctorId, id);
  await assertOwnedClinic(doctorId, clinicId);

  const copy = src.get({ plain: true });
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.clinic;

  // Assets are re-referenced, not re-uploaded: two templates may share a logo.
  // Deleting one template must therefore never delete the object — and it
  // doesn't, because remove() only runs on an explicit asset replace/delete.
  return PrescriptionTemplate.create({ ...copy, name, clinicId: clinicId ?? null, isDefault: false });
};

exports.remove = async (doctorId, id) => {
  const row = await findOwned(doctorId, id);

  const remaining = await PrescriptionTemplate.count({
    where: { doctorId, isActive: true, id: { [Op.ne]: row.id } },
  });
  if (remaining === 0) {
    throw new ApiError(409, "This is your last active letterhead — create another one first", {
      code: ERROR_CODES.TEMPLATE_IN_USE,
    });
  }

  // Soft delete. Finalized prescriptions render from their own snapshot, so old
  // PDFs survive; the FK is ON DELETE SET NULL purely for the "N prescriptions
  // used this" counter in the editor.
  await row.update({ isActive: false, isDefault: false });

  // Never leave the doctor without a default.
  if (!(await PrescriptionTemplate.count({ where: { doctorId, isActive: true, isDefault: true } }))) {
    const next = await PrescriptionTemplate.findOne({
      where: { doctorId, isActive: true },
      order: [["updatedAt", "DESC"]],
    });
    if (next) await next.update({ isDefault: true });
  }
  return row;
};

exports.putAsset = async (doctorId, id, kind, file) => {
  if (!TEMPLATE_ASSET_MIME.includes(file.mimetype)) {
    throw new ApiError(422, "A letterhead image must be a PNG or JPEG", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  const row = await findOwned(doctorId, id);
  const column = assetColumn(kind);
  const previous = row[column];

  await upload.storeThen(
    file.buffer,
    { keyPrefix: `prescription-assets/${doctorId}`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) => row.update({ [column]: url })
  );

  // Delete the old object only AFTER the new URL is committed. The other order
  // loses the old logo if the upload fails.
  if (previous) {
    pdfService.forgetAsset(previous); // drop the inlined data: URI from the render cache
    await upload.remove(upload.keyFromUrl(previous)).catch(() => {});
  }
  return findOwned(doctorId, id);
};

exports.removeAsset = async (doctorId, id, kind) => {
  const row = await findOwned(doctorId, id);
  const column = assetColumn(kind);
  const previous = row[column];
  await row.update({ [column]: null });
  if (previous) {
    pdfService.forgetAsset(previous); // drop the inlined data: URI from the render cache
    await upload.remove(upload.keyFromUrl(previous)).catch(() => {});
  }
  return findOwned(doctorId, id);
};

/**
 * Which letterhead does a prescription use? (README §3)
 *   1. an explicit templateId (must be owned)
 *   2. an active template for the booking's clinic
 *   3. the doctor's default
 *   4. auto-provision one from their profile
 */
exports.resolveTemplate = async (doctorId, { clinicId = null, templateId = null } = {}) => {
  if (templateId) return findOwned(doctorId, templateId);

  if (clinicId != null) {
    const byClinic = await PrescriptionTemplate.findOne({
      where: { doctorId, clinicId, isActive: true },
      include: withClinic,
      order: [["isDefault", "DESC"]],
    });
    if (byClinic) return byClinic;
  }

  const byDefault = await PrescriptionTemplate.findOne({
    where: { doctorId, isActive: true, isDefault: true },
    include: withClinic,
  });
  if (byDefault) return byDefault;

  const anyActive = await PrescriptionTemplate.findOne({
    where: { doctorId, isActive: true },
    include: withClinic,
  });
  if (anyActive) return anyActive;

  const clinic = clinicId != null ? await Clinic.findOne({ where: { id: clinicId, doctorId } }) : null;
  const seed = await buildDefaultTemplate(doctorId, clinic);
  const created = await PrescriptionTemplate.create({ ...seed, isDefault: true });
  return findOwned(doctorId, created.id);
};
