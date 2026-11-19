/**
 * Patient follow-up reminder controllers — the patient views upcoming follow-ups
 * and toggles WhatsApp consent.
 */
const followUpReminderService = require("../services/followUpReminder.service");
const { PatientProfile } = require("../models");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const { serializeUpcomingFollowUp } = require("../utils/serializers");

exports.listUpcoming = asyncHandler(async (req, res) => {
  const rows = await followUpReminderService.listUpcomingForPatient(req.user.id);
  return ok(res, rows.map(serializeUpcomingFollowUp), "Upcoming follow-ups");
});

exports.toggleWhatsAppOptIn = asyncHandler(async (req, res) => {
  const profile = await PatientProfile.findByPk(req.user.id);
  if (!profile) {
    return ok(res, { whatsappOptIn: false }, "Profile not found");
  }
  await profile.update({ whatsappOptIn: req.body.whatsappOptIn });
  return ok(res, { whatsappOptIn: Boolean(profile.whatsappOptIn) }, "WhatsApp preference saved");
});
