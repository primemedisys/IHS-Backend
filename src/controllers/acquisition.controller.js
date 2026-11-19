/**
 * Patient-side acquisition endpoints (migration 056) — thin.
 */
const acquisition = require("../services/acquisition.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");

exports.sources = asyncHandler(async (_req, res) => ok(res, acquisition.catalogue(), "Acquisition sources"));

exports.statusForDoctor = asyncHandler(async (req, res) => {
  const row = await acquisition.originalFor(req.user.id, req.params.doctorId);
  return ok(
    res,
    { answered: Boolean(row), group: row?.sourceGroup ?? null, source: row?.source ?? null },
    "Acquisition status"
  );
});
