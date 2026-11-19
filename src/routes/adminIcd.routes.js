/**
 * /admin/icd-codes — the admin-managed diagnosis / ICD catalogue (migration
 * 059). Admin-guarded like every other /admin router. No delete route: a row
 * is deactivated, never removed (recorded diagnoses keep their snapshot).
 */
const router = require("express").Router();

const controller = require("../controllers/adminIcd.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/icdCode.validator");
const upload = require("../middlewares/upload");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/icd-codes/meta", ...guard, controller.meta);
router.get("/icd-codes", ...guard, validateQuery(schema.listQuery), controller.list);
router.post("/icd-codes", ...guard, validate(schema.create), controller.create);
router.post("/icd-codes/import", ...guard, validate(schema.importBody), controller.importRows);
// Excel workflow: template → preview (writes nothing) → confirm the same file.
router.get("/icd-codes/import/template", ...guard, controller.excelTemplate);
router.post("/icd-codes/import/preview", ...guard, upload.single("file"), validate(schema.excelPreview), controller.excelPreview);
router.post("/icd-codes/import/excel", ...guard, upload.single("file"), validate(schema.excelCommit), controller.excelCommit);
router.get("/icd-codes/imports", ...guard, validateQuery(schema.historyQuery), controller.importHistory);
router.get("/icd-codes/doctor-entries", ...guard, validateQuery(schema.doctorEntriesQuery), controller.doctorEntries);
router.patch("/icd-codes/:id", ...guard, validate(schema.idParams, "params"), validate(schema.update), controller.update);

module.exports = router;
