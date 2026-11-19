/**
 * Public contact form. Thin wrapper: pass the validated body (plus the caller's
 * IP for spam triage) to the service, then return the created record's public
 * shape. No auth — anyone can reach the platform this way.
 */
const contactService = require("../services/contact.service");
const asyncHandler = require("../utils/asyncHandler");
const { created } = require("../utils/apiResponse");
const { serializeContactMessage } = require("../utils/serializers");

exports.create = asyncHandler(async (req, res) => {
  const record = await contactService.createMessage({ ...req.body, ipAddress: req.ip });
  return created(res, serializeContactMessage(record), "Message received");
});
