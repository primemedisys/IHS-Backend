/**
 * Joi schemas for admin-only writable endpoints. The doctor-editing surface the
 * admin drives (`/admin/doctors/:doctorId/*`) reuses the existing
 * `doctor.validator` schemas — only the create-a-doctor body is new here.
 */
const Joi = require("joi");

const createDoctor = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().trim().email().max(190).required(),
  // Admin-set; the doctor can reset it later via the existing forgot-password flow.
  password: Joi.string().min(8).max(72).required(),
});

/** The admin's verdict on a clinic (mirrors doctor.validator's verifyDoctor). */
const verifyClinic = Joi.object({
  decision: Joi.string().valid("approved", "rejected").required(),
  notes: Joi.string().trim().max(500).allow("", null),
});

/**
 * Suspend / reinstate an approved clinic. Independent of the verdict: the
 * account and its history survive, but every patient route stops answering.
 */
const setClinicActive = Joi.object({
  isActive: Joi.boolean().required(),
});

/** Doctor ids in the URL are numeric — anything else is a 422 before any query runs. */
const doctorIdParams = Joi.object({ id: Joi.string().pattern(/^\d{1,12}$/).required() });

/** Permanent deletion needs the exact typed phrase. */
const deleteDoctor = Joi.object({ confirmPhrase: Joi.string().valid("DELETE DOCTOR").required() });

/** Deactivate (false) / reactivate (true) a doctor account. */
const setDoctorActive = Joi.object({ isActive: Joi.boolean().required() });

module.exports = { createDoctor, verifyClinic, setClinicActive, doctorIdParams, deleteDoctor, setDoctorActive };
