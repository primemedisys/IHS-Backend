/**
 * Blood Bank portal controller (frontend-blood-bank) — thin handlers: validated
 * input → one service call → envelope. `req.bloodBankId` is set by
 * requireApprovedBloodBank; the profile routes (open to a pending bank) use
 * req.user.id directly.
 */
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const { serializeUser } = require("../utils/serializers");
const authService = require("../services/auth.service");
const profileService = require("../services/bloodBankProfile.service");
const donorService = require("../services/bloodDonor.service");
const inventoryService = require("../services/bloodInventory.service");
const requestService = require("../services/bloodRequest.service");
const campService = require("../services/bloodCamp.service");
const dashboardService = require("../services/bloodDashboard.service");
const searchService = require("../services/bloodSearch.service");
const auditService = require("../services/bloodAudit.service");
const sendFile = require("../utils/sendFile");

const bank = (req) => req.bloodBankId;
const actor = (req) => req.user.id;

// ── Auth ─────────────────────────────────────────────────────────────────

exports.register = asyncHandler(async (req, res) => {
  const { user, profile } = profileService.splitRegistration(req.body);
  const result = await authService.registerLocal(user, req, profile);
  return created(
    res,
    { user: serializeUser(result.user), tokens: result.tokens, profile: await profileService.getOwn(result.user.id) },
    "Blood bank registered — awaiting verification"
  );
});

exports.login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.loginBloodBank(req.body, req);
  return ok(res, { user: serializeUser(user), tokens }, "Logged in");
});

// ── Profile (open to a pending bank) ─────────────────────────────────────

exports.getProfile = asyncHandler(async (req, res) => ok(res, { profile: await profileService.getOwn(actor(req)) }));
exports.updateProfile = asyncHandler(async (req, res) =>
  ok(res, { profile: await profileService.updateOwn(actor(req), req.body) }, "Profile updated")
);
exports.reference = asyncHandler(async (_req, res) => ok(res, searchService.reference()));

// ── Dashboard + audit ────────────────────────────────────────────────────

exports.dashboard = asyncHandler(async (req, res) => ok(res, await dashboardService.bankDashboard(bank(req))));
exports.audit = asyncHandler(async (req, res) => ok(res, await auditService.listForBank(bank(req), req.validatedQuery)));

// ── Donors + screening ───────────────────────────────────────────────────

exports.listDonors = asyncHandler(async (req, res) => ok(res, await donorService.listDonors(bank(req), req.validatedQuery)));
exports.getDonor = asyncHandler(async (req, res) => ok(res, { donor: await donorService.getDonor(bank(req), req.params.id) }));
exports.createDonor = asyncHandler(async (req, res) =>
  created(res, { donor: await donorService.createDonor(bank(req), actor(req), req.body) }, "Donor registered")
);
exports.updateDonor = asyncHandler(async (req, res) =>
  ok(res, { donor: await donorService.updateDonor(bank(req), actor(req), req.params.id, req.body) }, "Donor updated")
);
exports.addScreening = asyncHandler(async (req, res) =>
  created(res, { screening: await donorService.addScreening(bank(req), actor(req), req.params.id, req.body) }, "Screening recorded")
);

// ── Donations + testing ──────────────────────────────────────────────────

exports.listDonations = asyncHandler(async (req, res) =>
  ok(res, await donorService.listDonations(bank(req), req.validatedQuery))
);
exports.getDonation = asyncHandler(async (req, res) =>
  ok(res, { donation: await donorService.getDonation(bank(req), req.params.id) })
);
exports.createDonation = asyncHandler(async (req, res) =>
  created(res, { donation: await donorService.createDonation(bank(req), actor(req), req.body) }, "Donation recorded")
);
exports.addTest = asyncHandler(async (req, res) =>
  created(res, { test: await donorService.addTest(bank(req), actor(req), req.params.id, req.body) }, "Test result recorded")
);
exports.decideTesting = asyncHandler(async (req, res) =>
  ok(res, { donation: await donorService.decideTesting(bank(req), actor(req), req.params.id, req.body) }, "Testing decision recorded")
);

// ── Units / inventory ────────────────────────────────────────────────────

exports.inventorySummary = asyncHandler(async (req, res) =>
  ok(res, await inventoryService.summary(bank(req), req.validatedQuery))
);
exports.listUnits = asyncHandler(async (req, res) => ok(res, await inventoryService.listUnits(bank(req), req.validatedQuery)));
exports.getUnit = asyncHandler(async (req, res) => ok(res, { unit: await inventoryService.getUnit(bank(req), req.params.id) }));
exports.updateUnit = asyncHandler(async (req, res) =>
  ok(res, { unit: await inventoryService.updateUnit(bank(req), actor(req), req.params.id, req.body) }, "Unit updated")
);
exports.releaseUnit = asyncHandler(async (req, res) =>
  ok(res, { unit: await inventoryService.release(bank(req), actor(req), req.params.id, req.body) }, "Unit released to inventory")
);
exports.discardUnit = asyncHandler(async (req, res) =>
  ok(res, { unit: await inventoryService.discard(bank(req), actor(req), req.params.id, req.body) }, "Unit discarded")
);
exports.separateUnit = asyncHandler(async (req, res) =>
  created(res, { units: await inventoryService.separate(bank(req), actor(req), req.params.id, req.body) }, "Components created")
);

// ── Requests ─────────────────────────────────────────────────────────────

exports.listRequests = asyncHandler(async (req, res) =>
  ok(res, await requestService.listForBank(bank(req), req.validatedQuery))
);
exports.getRequest = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.getForBank(bank(req), req.params.id) })
);
exports.requestDocument = asyncHandler(async (req, res) =>
  sendFile(res, await requestService.streamDocument(bank(req), req.params.id))
);
exports.setRequestStatus = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.setStatus(bank(req), actor(req), req.params.id, req.body) }, "Request updated")
);
exports.reserve = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.reserve(bank(req), actor(req), req.params.id, req.body) }, "Unit reserved")
);
exports.crossmatch = asyncHandler(async (req, res) =>
  created(res, { request: await requestService.recordCrossmatch(bank(req), actor(req), req.params.id, req.body) }, "Cross-match recorded")
);
exports.approve = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.approve(bank(req), actor(req), req.params.id, req.body) }, "Request approved")
);
exports.issue = asyncHandler(async (req, res) =>
  created(res, { request: await requestService.issue(bank(req), actor(req), req.params.id, req.body) }, "Unit issued")
);

// ── Registers ────────────────────────────────────────────────────────────

exports.listReservations = asyncHandler(async (req, res) =>
  ok(res, await requestService.listReservations(bank(req), req.validatedQuery))
);
exports.releaseReservation = asyncHandler(async (req, res) =>
  ok(res, { request: await requestService.releaseReservation(bank(req), actor(req), req.params.id, req.body) }, "Reservation released")
);
exports.listCrossmatches = asyncHandler(async (req, res) =>
  ok(res, await requestService.listCrossmatches(bank(req), req.validatedQuery))
);
exports.listIssues = asyncHandler(async (req, res) => ok(res, await requestService.listIssues(bank(req), req.validatedQuery)));

// ── Camps ────────────────────────────────────────────────────────────────

exports.listCamps = asyncHandler(async (req, res) => ok(res, await campService.list(bank(req), req.validatedQuery)));
exports.getCamp = asyncHandler(async (req, res) => ok(res, { camp: await campService.get(bank(req), req.params.id) }));
exports.createCamp = asyncHandler(async (req, res) =>
  created(res, { camp: await campService.create(bank(req), actor(req), req.body) }, "Camp created")
);
exports.updateCamp = asyncHandler(async (req, res) =>
  ok(res, { camp: await campService.update(bank(req), actor(req), req.params.id, req.body) }, "Camp updated")
);
exports.setCampRegistration = asyncHandler(async (req, res) =>
  ok(
    res,
    { registration: await campService.setRegistrationStatus(bank(req), req.params.id, req.params.registrationId, req.body.status) },
    "Registration updated"
  )
);
