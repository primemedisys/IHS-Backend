/**
 * Patient "My Medicines" controllers — thin. Every call is keyed on
 * req.user.id; ownership is the service's WHERE clause.
 */
const svc = require("../services/patientMedicine.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const {
  serializeRoutine,
  serializeDose,
  serializeMedicineSettings,
  serializeCatalogueHit,
  serializeMedicineSummary,
} = require("../utils/patientMedicineSerializers");

const me = (req) => req.user.id;

exports.list = asyncHandler(async (req, res) =>
  ok(res, (await svc.list(me(req), req.validatedQuery)).map(serializeRoutine), "Medicines")
);

exports.search = asyncHandler(async (req, res) =>
  ok(res, (await svc.searchCatalogue(req.validatedQuery.q)).map(serializeCatalogueHit), "Medicines")
);

exports.summary = asyncHandler(async (req, res) =>
  ok(res, serializeMedicineSummary(await svc.summary(me(req))), "Medicine summary")
);

exports.getOne = asyncHandler(async (req, res) => {
  const { routine, doses } = await svc.getOne(me(req), req.params.id);
  return ok(res, { ...serializeRoutine(routine), recentDoses: doses.map(serializeDose) }, "Medicine");
});

exports.create = asyncHandler(async (req, res) =>
  created(res, (await svc.createMany(me(req), req.body)).map(serializeRoutine), "Medicines saved")
);

exports.update = asyncHandler(async (req, res) =>
  ok(res, serializeRoutine(await svc.update(me(req), req.params.id, req.body)), "Medicine updated")
);

exports.setStatus = asyncHandler(async (req, res) =>
  ok(res, serializeRoutine(await svc.setStatus(me(req), req.params.id, req.body)), "Medicine updated")
);

exports.doses = asyncHandler(async (req, res) =>
  ok(res, (await svc.listDoses(me(req), req.validatedQuery)).map(serializeDose), "Doses")
);

exports.history = asyncHandler(async (req, res) => {
  const page = await svc.history(me(req), req.validatedQuery);
  return ok(res, { ...page, doses: page.doses.map(serializeDose) }, "Dose history");
});

exports.doseAction = asyncHandler(async (req, res) => {
  const { dose, changed } = await svc.doseAction(me(req), req.params.doseId, req.body);
  return ok(res, { dose: serializeDose(dose), changed }, changed ? "Dose updated" : "Already recorded");
});

exports.getSettings = asyncHandler(async (req, res) =>
  ok(res, serializeMedicineSettings(await svc.getSettings(me(req))), "Reminder settings")
);

exports.updateSettings = asyncHandler(async (req, res) =>
  ok(res, serializeMedicineSettings(await svc.updateSettings(me(req), req.body)), "Reminder settings saved")
);
