/**
 * /admin contact-inbox routes. Every route is guarded `authenticate` +
 * `authorize('admin')`. The admin UI (frontend-admin "Messages") codes against
 * these; the public submit endpoint is separate (`/contact`).
 */
const router = require("express").Router();

const adminContact = require("../controllers/adminContact.controller");
const validate = require("../middlewares/validate");
const validateQuery = require("../middlewares/validateQuery");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const schema = require("../validators/contact.validator");
const { ROLES } = require("../config/constants");

const guard = [authenticate, authorize(ROLES.ADMIN)];

router.get("/contact-messages", ...guard, validateQuery(schema.listMessages), adminContact.list);
router.patch(
  "/contact-messages/:id",
  ...guard,
  validate(schema.updateMessage),
  adminContact.update
);

module.exports = router;
