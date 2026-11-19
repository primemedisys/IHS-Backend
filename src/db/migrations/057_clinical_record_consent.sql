-- 057: Section-wise consent for a treating doctor to see a patient's clinical
-- history written by OTHER doctors (medical history, consultations, diagnoses,
-- medications, investigations, doctor notes, vitals).
--
-- Reuses the consent pipeline of migration 045 (doctor_access_requests +
-- access_audit_logs + in-app notifications): one request row per category, so
-- the patient approves or declines each category on its own; the grant expires
-- and can be revoked. A clinical-category request has no grant items — the
-- category itself is the grant, enforced on every read by the backend.
--
-- ADDITIVE ONLY: the category ENUM gains seven values. Existing rows and the
-- five document categories are unchanged. Applied by `npm run migrate` and,
-- idempotently, by db/ensureClinicalRecordConsent.js on every boot.

ALTER TABLE doctor_access_requests
  MODIFY COLUMN category ENUM(
    'prescription','lab_report','xray','mri','other',
    'medical_history','consultations','diagnoses','medications','investigations','doctor_notes','vitals'
  ) NOT NULL;
