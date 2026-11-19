/**
 * Doctor-facing medicine master-list controllers — thin. Ownership is enforced
 * in the service's WHERE clause, so nothing here checks it.
 */
const medicineService = require("../services/doctorMedicine.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { plain } = require("../utils/serializers");

const serializeMedicine = (m) => {
  if (!m) return null;
  const x = typeof m.get === "function" ? m.get({ plain: true }) : m;
  return {
    id: String(x.id),
    doctorId: String(x.doctorId),
    medicineMasterId: x.medicineMasterId != null ? String(x.medicineMasterId) : null,
    name: x.name,
    genericName: x.genericName ?? null,
    manufacturer: x.manufacturer ?? null,
    description: x.description ?? null,
    form: x.form,
    dosageForm: x.dosageForm ?? null,
    strength: x.strength ?? null,
    defaultFrequency: x.defaultFrequency || null,
    defaultTiming: x.defaultTiming ?? null,
    category: x.category ?? null,
    isActive: Boolean(x.isActive),
    createdAt: x.createdAt ?? null,
    updatedAt: x.updatedAt ?? null,
  };
};

exports.list = asyncHandler(async (req, res) => {
  const rows = await medicineService.list(req.doctorId, {
    search: req.query.search,
    category: req.query.category,
    form: req.query.form,
  });
  return ok(res, rows.map(serializeMedicine), "Medicines");
});

exports.listAll = asyncHandler(async (req, res) => {
  const rows = await medicineService.listAll(req.doctorId, {
    search: req.query.search,
    category: req.query.category,
    form: req.query.form,
  });
  return ok(res, rows.map(serializeMedicine), "Medicines");
});

exports.getOne = asyncHandler(async (req, res) => {
  const med = await medicineService.getOne(req.doctorId, req.params.id);
  return ok(res, serializeMedicine(med), "Medicine");
});

exports.create = asyncHandler(async (req, res) => {
  const med = await medicineService.create(req.doctorId, req.body);
  return created(res, serializeMedicine(med), "Medicine created");
});

exports.update = asyncHandler(async (req, res) => {
  const med = await medicineService.update(req.doctorId, req.params.id, req.body);
  return ok(res, serializeMedicine(med), "Medicine updated");
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await medicineService.remove(req.doctorId, req.params.id);
  return ok(res, result, "Medicine deactivated");
});
