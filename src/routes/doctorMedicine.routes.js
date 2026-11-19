/**
 * /doctor medicines routes — CRUD for the doctor's personal medicine master list.
 * Mounted under `/doctor` alongside doctor.routes.js / clinic.routes.js / etc.
 * Every route is guarded `authenticate` + `authorize('doctor')` +
 * resolveDoctorId('self'), so controllers read `req.doctorId` and ownership is
 * never a controller's problem.
 */
const router = require("express").Router();

const med = require("../controllers/doctorMedicine.controller");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const resolveDoctorId = require("../middlewares/resolveDoctorId");
const s = require("../validators/doctorMedicine.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.DOCTOR), resolveDoctorId("self")];

router
  .route("/medicines")
  .all(...guard)
  .get(med.list)
  .post(validate(s.createMedicine), med.create);

// Management endpoint: returns ALL medicines including inactive ones
router.get("/medicines/all", ...guard, med.listAll);

router
  .route("/medicines/:id")
  .all(...guard)
  .get(med.getOne)
  .patch(validate(s.updateMedicine), med.update)
  .delete(med.remove);

module.exports = router;
