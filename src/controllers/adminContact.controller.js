/**
 * Admin contact-inbox controllers (guarded `role='admin'` in the routes). Thin
 * wrappers over contact.service: list the submissions, and toggle a message's
 * `handled` flag. The public submit endpoint lives in contact.controller.js.
 */
const contactService = require("../services/contact.service");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeContactMessageForAdmin } = require("../utils/serializers");

exports.list = asyncHandler(async (req, res) => {
  const result = await contactService.listMessages(req.validatedQuery);
  return ok(
    res,
    { ...result, data: result.data.map(serializeContactMessageForAdmin) },
    "Contact messages"
  );
});

exports.update = asyncHandler(async (req, res) => {
  const record = await contactService.setHandled(req.params.id, req.body.handled);
  return ok(res, serializeContactMessageForAdmin(record), "Message updated");
});
