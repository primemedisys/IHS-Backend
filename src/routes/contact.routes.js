/**
 * Public "Contact us" form. One endpoint: POST /contact. No auth. Guarded by a
 * dedicated per-IP rate limiter (public write → spam target) and validated by
 * Joi before the controller runs. Mounted at the API root, so the path is
 * `POST /api/contact`.
 */
const router = require("express").Router();

const contact = require("../controllers/contact.controller");
const validate = require("../middlewares/validate");
const { contactLimiter } = require("../middlewares/rateLimiters");
const schema = require("../validators/contact.validator");

router.post("/", contactLimiter, validate(schema.createMessage), contact.create);

module.exports = router;
