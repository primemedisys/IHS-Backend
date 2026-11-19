/**
 * Blood Bank portal routes (migration 039), mounted at /api/blood-bank.
 *
 *   authenticate → authorize(blood_bank) → [requireApprovedBloodBank] → validate → controller
 *
 * Only the profile + reference routes are open to a PENDING bank (so it can
 * finish its details); everything operational requires admin approval.
 * Ownership is enforced again in every service (blood_bank_id scoping).
 */
const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const requireApproved = require("../middlewares/requireApprovedBloodBank");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const { ROLES } = require("../config/constants");
const c = require("../controllers/bloodBank.controller");
const v = require("../validators/bloodBank.validator");

const signedIn = [authenticate, authorize(ROLES.BLOOD_BANK)];
const bank = [...signedIn, requireApproved];

// ── Profile / reference (pending banks too) ──────────────────────────────
router.get("/profile", ...signedIn, c.getProfile);
router.put("/profile", ...signedIn, validate(v.updateProfile), c.updateProfile);
router.get("/reference", ...signedIn, c.reference);

// ── Dashboard + audit ────────────────────────────────────────────────────
router.get("/dashboard", ...bank, c.dashboard);
router.get("/audit", ...bank, validateQuery(v.listAudit), c.audit);

// ── Donors ───────────────────────────────────────────────────────────────
router.get("/donors", ...bank, validateQuery(v.listDonors), c.listDonors);
router.post("/donors", ...bank, validate(v.createDonor), c.createDonor);
router.get("/donors/:id", ...bank, c.getDonor);
router.put("/donors/:id", ...bank, validate(v.updateDonor), c.updateDonor);
router.post("/donors/:id/screenings", ...bank, validate(v.screening), c.addScreening);

// ── Donations + testing ──────────────────────────────────────────────────
router.get("/donations", ...bank, validateQuery(v.listDonations), c.listDonations);
router.post("/donations", ...bank, validate(v.createDonation), c.createDonation);
router.get("/donations/:id", ...bank, c.getDonation);
router.post("/donations/:id/tests", ...bank, validate(v.addTest), c.addTest);
router.put("/donations/:id/testing", ...bank, validate(v.testingDecision), c.decideTesting);

// ── Units / inventory ────────────────────────────────────────────────────
router.get("/inventory", ...bank, validateQuery(v.inventorySummary), c.inventorySummary);
router.get("/units", ...bank, validateQuery(v.listUnits), c.listUnits);
router.get("/units/:id", ...bank, c.getUnit);
router.put("/units/:id", ...bank, validate(v.updateUnit), c.updateUnit);
router.post("/units/:id/release", ...bank, validate(v.releaseUnit), c.releaseUnit);
router.post("/units/:id/discard", ...bank, validate(v.discardUnit), c.discardUnit);
router.post("/units/:id/separate", ...bank, validate(v.separate), c.separateUnit);

// ── Requests ─────────────────────────────────────────────────────────────
router.get("/requests", ...bank, validateQuery(v.listBankRequests), c.listRequests);
router.get("/requests/:id", ...bank, c.getRequest);
router.get("/requests/:id/document", ...bank, c.requestDocument);
router.put("/requests/:id/status", ...bank, validate(v.requestStatus), c.setRequestStatus);
router.post("/requests/:id/reservations", ...bank, validate(v.reserve), c.reserve);
router.post("/requests/:id/crossmatches", ...bank, validate(v.crossmatch), c.crossmatch);
router.post("/requests/:id/approve", ...bank, validate(v.approve), c.approve);
router.post("/requests/:id/issues", ...bank, validate(v.issue), c.issue);

// ── Registers ────────────────────────────────────────────────────────────
router.get("/reservations", ...bank, validateQuery(v.listReservations), c.listReservations);
router.post("/reservations/:id/release", ...bank, validate(v.releaseReservation), c.releaseReservation);
router.get("/crossmatches", ...bank, validateQuery(v.listCrossmatches), c.listCrossmatches);
router.get("/issues", ...bank, validateQuery(v.listIssues), c.listIssues);

// ── Camps ────────────────────────────────────────────────────────────────
router.get("/camps", ...bank, validateQuery(v.listCamps), c.listCamps);
router.post("/camps", ...bank, validate(v.createCamp), c.createCamp);
router.get("/camps/:id", ...bank, c.getCamp);
router.put("/camps/:id", ...bank, validate(v.updateCamp), c.updateCamp);
router.put(
  "/camps/:id/registrations/:registrationId",
  ...bank,
  validate(v.campRegistrationStatus),
  c.setCampRegistration
);

module.exports = router;
