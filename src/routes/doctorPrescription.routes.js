/**
 * /doctor prescription routes (docs/prescriptions §5.1–5.2). Mounted under
 * `/doctor` alongside doctor.routes.js / clinic.routes.js / doctorBooking.routes.js.
 * Every route is guarded `authenticate` + `authorize('doctor')` +
 * resolveDoctorId('self'), so controllers read `req.doctorId` and ownership is
 * never a controller's problem.
 */
const router = require("express").Router();

const tpl = require("../controllers/prescriptionTemplate.controller");
const rx = require("../controllers/prescription.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const upload = require("../middlewares/upload");
const { pdfLimiter } = require("../middlewares/rateLimiters");
const s = require("../validators/prescription.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

// ── Letterhead templates ─────────────────────────────────────────────────────
router
  .route("/prescription-templates")
  .all(...guard)
  .get(tpl.list)
  .post(validate(s.createTemplate), tpl.create);

// The PDF preview must be declared BEFORE `/:id`, or "12/preview.pdf" is fine
// but a future "/preview.pdf" style route would be swallowed by the param.
router.get("/prescription-templates/:id/preview.pdf", ...guard, pdfLimiter, tpl.previewPdf);
router.post("/prescription-templates/:id/default", ...guard, tpl.setDefault);
router.post(
  "/prescription-templates/:id/duplicate",
  ...guard,
  validate(s.duplicateTemplate),
  tpl.duplicate
);
// multer runs first so `req.body.kind` exists by the time `validate` reads it.
router.post(
  "/prescription-templates/:id/assets",
  ...guard,
  upload.single("file"),
  validate(s.uploadAsset),
  tpl.putAsset
);
router.delete("/prescription-templates/:id/assets/:kind", ...guard, tpl.removeAsset);

router
  .route("/prescription-templates/:id")
  .all(...guard)
  .get(tpl.getOne)
  .patch(validate(s.updateTemplate), tpl.update)
  .delete(tpl.remove);

// ── Prescriptions ────────────────────────────────────────────────────────────
router
  .route("/prescriptions")
  .all(...guard)
  // No `validate(..., "query")`: Express 5 exposes req.query as a getter-only
  // property, so the middleware's `req[property] = value` would throw. The
  // controller picks the known filter keys instead — same as doctorBooking.
  .get(rx.list)
  .post(validate(s.createPrescription), rx.create);

router.post("/prescriptions/:id/finalize", ...guard, pdfLimiter, validate(s.finalizePrescription), rx.finalize);
router.post("/prescriptions/:id/amend", ...guard, validate(s.amendPrescription), rx.amend);
// Migration 059 — refill a draft from its Patient Workbench consultation (reads the Workbench only).
router.post("/prescriptions/:id/sync-workbench", ...guard, rx.syncWorkbench);
router.get("/prescriptions/:id/pdf", ...guard, rx.pdf);

router
  .route("/prescriptions/:id")
  .all(...guard)
  .get(rx.getOne)
  .patch(validate(s.updatePrescription), rx.update)
  .delete(rx.remove);

// Convenience read for the appointment screen: "Write Rx" vs "View Rx" in one call.
router.get("/bookings/:id/prescription", ...guard, rx.byBooking);

module.exports = router;
