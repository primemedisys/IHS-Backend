/**
 * Joi schemas for the multi-doctor referral endpoints (docs/multi-doctor-referrals).
 * Shape only — ownership, the confirmed/completed gate, and "target is an
 * approved active doctor" are business rules enforced in referral.service.
 */
const Joi = require("joi");
const { REFERRAL_STATUS } = require("../config/constants");

/** POST /doctor/bookings/:id/referrals — make a referral from this consult. */
const createReferral = Joi.object({
  toDoctorId: Joi.number().integer().positive().required(),
  reason: Joi.string().trim().min(3).max(500).required(),
  note: Joi.string().trim().max(1000).allow("", null),
});

/** GET /doctor/referral-targets?q=&clinicId= — the name autocomplete. */
const listTargets = Joi.object({
  q: Joi.string().trim().min(1).max(80).required(),
  clinicId: Joi.number().integer().positive().optional(),
});

/** PATCH /doctor/referrals/:id — cancel-only for MVP. */
const cancelReferral = Joi.object({
  status: Joi.string().valid(REFERRAL_STATUS.CANCELLED).required(),
});

module.exports = { createReferral, listTargets, cancelReferral };
