/**
 * Joi schemas for doctor record-access consent (migration 045).
 *
 * No body ever carries a doctor id, a status or a "granted" flag: the doctor is
 * the authenticated user, a status only changes through the patient's own
 * approve / reject / revoke endpoints, and the shared documents are exactly the
 * record ids the PATIENT sends on approval.
 */
const Joi = require("joi");
const {
  DOCUMENT_ACCESS_CATEGORIES,
  CLINICAL_ACCESS_CATEGORIES,
  ACCESS_GRANT_DAYS,
  ACCESS_GRANT_DEFAULT_DAYS,
  ACCESS_MAX_ITEMS,
  ACCESS_REQUEST_STATUS,
} = require("../config/constants");

const id = Joi.number().integer().positive();

/** GET /doctor/patient-search?q= — at least 3 characters; never browses everyone. */
const patientSearch = Joi.object({
  q: Joi.string().trim().min(3).max(120).required(),
});

const patientIdParam = Joi.object({ patientId: id.required() });
const idParam = Joi.object({ id: id.required() });
const recordFileParams = Joi.object({ id: id.required(), recordId: id.required() });

/** POST /doctor/access-requests */
const createAccessRequest = Joi.object({
  patientId: id.required(),
  category: Joi.string()
    .valid(...DOCUMENT_ACCESS_CATEGORIES)
    .required(),
  purpose: Joi.string().trim().min(10).max(500).required(),
});

/**
 * POST /doctor/emr/patients/:patientId/access-requests (migration 057) — a
 * treating doctor asks for one or more clinical-history categories. Each
 * category becomes its own request, so the patient decides each one.
 */
const createClinicalAccessRequest = Joi.object({
  categories: Joi.array()
    .items(Joi.string().valid(...CLINICAL_ACCESS_CATEGORIES))
    .min(1)
    .max(CLINICAL_ACCESS_CATEGORIES.length)
    .unique()
    .required(),
  purpose: Joi.string().trim().max(500).allow("", null),
});

const listQuery = Joi.object({
  status: Joi.string().valid(...Object.values(ACCESS_REQUEST_STATUS)),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const doctorListQuery = listQuery.keys({ patientId: id });

/** POST /patient/access-requests/:id/approve */
// `recordIds` is required for a DOCUMENT request and ignored for a clinical one;
// the service knows the request's category and enforces that.
const approveAccessRequest = Joi.object({
  recordIds: Joi.array().items(id).min(1).max(ACCESS_MAX_ITEMS).unique(),
  durationDays: Joi.number()
    .valid(...ACCESS_GRANT_DAYS)
    .default(ACCESS_GRANT_DEFAULT_DAYS),
});

/** POST /patient/access-requests/:id/reject */
const rejectAccessRequest = Joi.object({
  note: Joi.string().trim().max(500).allow("", null),
});

module.exports = {
  patientSearch,
  patientIdParam,
  idParam,
  recordFileParams,
  createAccessRequest,
  createClinicalAccessRequest,
  listQuery,
  doctorListQuery,
  approveAccessRequest,
  rejectAccessRequest,
};
