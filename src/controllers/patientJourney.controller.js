/**
 * Patient care-journey controllers — deliberately THIN. Read `req.user.id`, call
 * one careJourney.service function, serialize. Ownership is a WHERE in the service.
 */
const journeyService = require("../services/careJourney.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const {
  serializeJourneySummary,
  serializeJourneyDetail,
  serializePendingReferral,
} = require("../utils/serializers");

/** GET /patient/journeys — journey summaries + the pending-referral inbox. */
exports.list = asyncHandler(async (req, res) => {
  const { summaries, pendingReferrals } = await journeyService.listForPatient(req.user.id);
  return ok(
    res,
    {
      journeys: summaries.map(serializeJourneySummary),
      pendingReferrals: pendingReferrals.map(serializePendingReferral),
    },
    "Your care journeys"
  );
});

/** GET /patient/journeys/:id — the whole flow (consultations + reports + Rx + edges). */
exports.getOne = asyncHandler(async (req, res) => {
  const detail = await journeyService.getForPatient(req.user.id, req.params.id);
  return ok(res, serializeJourneyDetail(detail), "Care journey");
});
