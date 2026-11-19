/**
 * Private file links (CLOUDINARY_SETUP.md). Mounted at /api/files. The `:name`
 * segment is only for the browser/viewer (it keeps the file extension in the
 * URL); the token alone decides which file is served.
 */
const router = require("express").Router();
const file = require("../controllers/file.controller");

router.get("/:token/:name", file.open);

module.exports = router;
