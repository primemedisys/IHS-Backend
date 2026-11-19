/**
 * The patient's own treatment timeline (docs/treatment-timeline §5.1). Thin:
 * validated query in, one service call, serialize, respond. Ownership is the
 * service's WHERE — `req.user.id` is never taken from the request body.
 */
const timelineService = require("../services/treatmentTimeline.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeTimeline } = require("../utils/serializers");

exports.list = asyncHandler(async (req, res) => {
  const result = await timelineService.listForPatient(req.user.id, req.validatedQuery);
  return ok(res, serializeTimeline(result, { viewer: "patient" }), "Treatment timeline");
});
