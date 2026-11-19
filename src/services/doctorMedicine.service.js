/**
 * Doctor medicine master-list service. Ownership is always scoped to
 * `doctorId` — a doctor can never see or modify another doctor's medicines.
 */
const { Op } = require("sequelize");
const { sequelize, Medicine, MedicineMaster } = require("../models");
const { cleanDisplay } = require("../utils/medicineIdentity");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES, ROLES } = require("../config/constants");
const { resolveMaster } = require("./medicineStore.service");

/** "100 mg", "100mg", "100 MG" → "100MG". Only spacing and case are ignored. */
const compactStrength = (s) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * An ACTIVE catalogue medicine with the same name and dosage form whose
 * strength differs only in spacing/case. Name compares through the column's
 * case-insensitive collation after whitespace is collapsed.
 */
async function catalogueTwin(dto, transaction) {
  const rows = await MedicineMaster.findAll({
    where: { medicineName: cleanDisplay(dto.name), medicineType: dto.dosageForm, isActive: true },
    attributes: ["id", "strength"],
    transaction,
  });
  return rows.find((r) => compactStrength(r.strength) === compactStrength(dto.strength)) ?? null;
}

/**
 * Link a doctor medicine to the shared IHS catalogue (migration 055): the
 * catalogue row the doctor picked, or the existing one with the same
 * NAME|STRENGTH|FORM identity, created only when none exists — no admin
 * approval, no duplicates (identity_key is UNIQUE). Without a dosage form the
 * identity is incomplete, so the medicine simply stays unlinked.
 */
async function catalogueLink(doctorId, dto, transaction) {
  if (!dto.medicineMasterId && !dto.dosageForm) return null;
  // "Zerodol 100 mg" typed as "zerodol 100MG" is the same catalogue medicine:
  // reuse it rather than letting spacing in the strength create a near-twin.
  // A different strength or dosage form never matches.
  const twin = dto.medicineMasterId ? null : await catalogueTwin(dto, transaction);
  const master = await resolveMaster(
    doctorId,
    {
      medicineMasterId: dto.medicineMasterId || twin?.id || null,
      medicineName: dto.name,
      genericName: dto.genericName || null,
      medicineType: dto.dosageForm,
      strength: dto.strength || null,
      manufacturer: dto.manufacturer || null,
      description: dto.description || null,
    },
    transaction,
    { role: ROLES.DOCTOR }
  );
  return master.id;
}

/**
 * List a doctor's active medicines, optionally filtered by search term,
 * category, or form.
 */
exports.list = async (doctorId, { search, category, form } = {}) => {
  const where = { doctorId, isActive: true };

  if (search) {
    where.name = { [Op.like]: `%${search}%` };
  }
  if (category) {
    where.category = category;
  }
  if (form) {
    where.form = form;
  }

  return Medicine.findAll({
    where,
    order: [["name", "ASC"]],
  });
};

/**
 * List ALL medicines for a doctor (including inactive), for management UI.
 */
exports.listAll = async (doctorId, { search, category, form } = {}) => {
  const where = { doctorId };

  if (search) {
    where.name = { [Op.like]: `%${search}%` };
  }
  if (category) {
    where.category = category;
  }
  if (form) {
    where.form = form;
  }

  return Medicine.findAll({
    where,
    order: [["isActive", "DESC"], ["name", "ASC"]],
  });
};

/** Get a single medicine, enforcing ownership. */
exports.getOne = async (doctorId, id) => {
  const med = await Medicine.findOne({ where: { id, doctorId } });
  if (!med) throw new ApiError(404, "Medicine not found", { code: ERROR_CODES.NOT_FOUND });
  return med;
};

/**
 * Same medicine = same name and strength, ignoring case and spacing — and the
 * same dosage form when both have one (Zerodol 100 mg tablet ≠ Zerodol 100 mg gel).
 */
const sameKey = (name, strength) =>
  `${String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ")}|${String(strength ?? "").trim().toLowerCase().replace(/\s+/g, "")}`;
const sameForm = (a, b) => !a || !b || a === b;

/**
 * Create a new medicine for the doctor. An ACTIVE medicine with the same name
 * and strength is a duplicate → 409 MEDICINE_DUPLICATE (details.medicineId, so
 * the client can pick the existing one). A deactivated twin is reactivated
 * instead of creating a second row.
 */
exports.create = async (doctorId, dto) => {
  const key = sameKey(dto.name, dto.strength);
  const twins = (await Medicine.findAll({ where: { doctorId, name: String(dto.name).trim() } })).filter(
    (m) => sameKey(m.name, m.strength) === key && sameForm(m.dosageForm, dto.dosageForm)
  );
  const active = twins.find((m) => m.isActive);
  if (active) {
    throw ApiError.conflict("This medicine is already in your list.", {
      code: ERROR_CODES.MEDICINE_DUPLICATE,
      details: { medicineId: String(active.id) },
    });
  }
  return sequelize.transaction(async (transaction) => {
    const medicineMasterId = await catalogueLink(doctorId, dto, transaction);
    const values = { ...dto, medicineMasterId: medicineMasterId ?? dto.medicineMasterId ?? null };
    if (twins[0]) {
      await twins[0].update({ ...values, isActive: true }, { transaction });
      return twins[0];
    }
    return Medicine.create({ ...values, doctorId }, { transaction });
  });
};

/**
 * Update a medicine (ownership enforced by WHERE). Renaming / re-strengthening
 * it into another ACTIVE entry of the list is the same duplicate create refuses.
 */
exports.update = async (doctorId, id, dto) => {
  const med = await exports.getOne(doctorId, id);
  if (dto.name !== undefined || dto.strength !== undefined || dto.dosageForm !== undefined) {
    const name = dto.name ?? med.name;
    const form = dto.dosageForm !== undefined ? dto.dosageForm : med.dosageForm;
    const key = sameKey(name, dto.strength !== undefined ? dto.strength : med.strength);
    const twin = (await Medicine.findAll({ where: { doctorId, isActive: true, name: String(name).trim() } })).find(
      (m) => String(m.id) !== String(med.id) && sameKey(m.name, m.strength) === key && sameForm(m.dosageForm, form)
    );
    if (twin) {
      throw ApiError.conflict("Another medicine in your list already has this name and strength.", {
        code: ERROR_CODES.MEDICINE_DUPLICATE,
        details: { medicineId: String(twin.id) },
      });
    }
  }
  const identityChanged = ["name", "strength", "dosageForm", "medicineMasterId"].some((k) => dto[k] !== undefined);
  await sequelize.transaction(async (transaction) => {
    const values = { ...dto };
    if (identityChanged) {
      const merged = {
        name: dto.name ?? med.name,
        strength: dto.strength !== undefined ? dto.strength : med.strength,
        dosageForm: dto.dosageForm !== undefined ? dto.dosageForm : med.dosageForm,
        genericName: dto.genericName !== undefined ? dto.genericName : med.genericName,
        manufacturer: dto.manufacturer !== undefined ? dto.manufacturer : med.manufacturer,
        description: dto.description !== undefined ? dto.description : med.description,
        medicineMasterId: dto.medicineMasterId,
      };
      values.medicineMasterId = await catalogueLink(doctorId, merged, transaction);
    }
    await med.update(values, { transaction });
  });
  return med;
};

/** Soft-delete (deactivate) a medicine. */
exports.remove = async (doctorId, id) => {
  const med = await exports.getOne(doctorId, id);
  await med.update({ isActive: false });
  return { id: String(id) };
};

exports.compactStrength = compactStrength;
