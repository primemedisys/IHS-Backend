/**
 * Doctor earnings + admin revenue reads. THIN — the period math lives in
 * `utils/period`, the aggregates in `earnings.service`, the money casting in
 * `utils/serializers`.
 *
 * `req.validatedQuery` (not `req.query`): Express 5 makes `req.query` a getter
 * with no setter, so `middlewares/validateQuery` publishes the coerced value
 * beside it. See validators/dashboard.validator.js.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const earningsService = require("../services/earnings.service");
const { resolveRange } = require("../utils/period");
const {
  serializeEarningsSummary,
  serializeEarningsBucket,
  serializeLedgerRow,
  serializeRevenueBucket,
} = require("../utils/serializers");

// ── Doctor ───────────────────────────────────────────────────────────────────

exports.summary = asyncHandler(async (req, res) => {
  const range = resolveRange(req.validatedQuery);
  const data = await earningsService.doctorSummary(req.doctorId, range);
  return ok(res, serializeEarningsSummary(data, range), "Earnings summary");
});

exports.series = asyncHandler(async (req, res) => {
  const range = resolveRange(req.validatedQuery);
  const buckets = await earningsService.doctorSeries(req.doctorId, range);
  return ok(
    res,
    { granularity: range.granularity, buckets: buckets.map(serializeEarningsBucket) },
    "Earnings series"
  );
});

exports.transactions = asyncHandler(async (req, res) => {
  const { page, limit } = req.validatedQuery;
  const range = resolveRange(req.validatedQuery);
  const result = await earningsService.doctorTransactions(req.doctorId, { ...range, page, limit });
  return ok(
    res,
    {
      rows: result.rows.map(serializeLedgerRow),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    },
    "Transactions"
  );
});

// ── Admin ────────────────────────────────────────────────────────────────────

exports.revenueSeries = asyncHandler(async (req, res) => {
  const range = resolveRange(req.validatedQuery);
  const buckets = await earningsService.platformSeries(range);
  return ok(
    res,
    { granularity: range.granularity, buckets: buckets.map(serializeRevenueBucket) },
    "Revenue series"
  );
});

exports.topDoctors = asyncHandler(async (req, res) => {
  const { limit } = req.validatedQuery;
  const range = resolveRange(req.validatedQuery);
  const rows = await earningsService.topDoctors(range, limit);
  return ok(res, { rows }, "Top doctors"); // already plain objects with cast money
});
